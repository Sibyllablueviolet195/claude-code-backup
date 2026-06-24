/**
 * git-sync.mjs — Git operations for backup repo.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { join, dirname } from "node:path";

const exec = promisify(execFile);

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function git(args, cwd) {
  // core.longpaths=true  — let Git for Windows handle paths over the 260-char
  //   MAX_PATH limit (deeply-nested plugin skills exceed it, which otherwise
  //   makes `git add` fail with "Filename too long"). No-op on Linux/macOS.
  // core.autocrlf=false  — back up files byte-for-byte; never rewrite line
  //   endings, so restores are faithful and diffs don't churn on Windows.
  return exec("git", ["-c", "core.longpaths=true", "-c", "core.autocrlf=false", ...args], {
    cwd,
    timeout: 120_000,
    // A large initial commit lists thousands of files; the default 1 MB stdout
    // buffer overflows. Allow generous output so commit/push never EPIPE.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh" },
  });
}

// ── GitHub CLI helpers ───────────────────────────────────────────────
// Optional onboarding aid: when the `gh` CLI is installed and authenticated,
// `init` can create the private backup repo automatically over HTTPS instead
// of requiring the user to pre-create it and configure an SSH key.

/** Is the `gh` CLI installed? */
export async function ghAvailable() {
  try { await exec("gh", ["--version"], { timeout: 10_000 }); return true; }
  catch { return false; }
}

/** Return the authenticated GitHub login, or null if gh isn't authenticated. */
export async function ghAuthedUser() {
  try {
    const { stdout } = await exec("gh", ["api", "user", "-q", ".login"], { timeout: 15_000 });
    const login = stdout.trim();
    return login || null;
  } catch {
    return null;
  }
}

/**
 * Create a private GitHub repo via `gh` and return its HTTPS clone URL.
 * Throws if creation fails (e.g. name already taken) so the caller can fall
 * back to the manual remote prompt.
 */
export async function ghCreateRepo(name) {
  await exec("gh", ["repo", "create", name, "--private"], { timeout: 30_000 });
  const user = await ghAuthedUser();
  if (!user) throw new Error("gh repo created but could not resolve authenticated user");
  return `https://github.com/${user}/${name}.git`;
}

/**
 * Check if a directory is a git repo.
 */
export async function isGitRepo(dir) {
  try {
    await access(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone an existing backup repo into `dir` (used when a second machine joins an
 * existing shared backup). `dir` must not already exist or must be empty.
 */
export async function cloneRepo(url, dir) {
  await git(["clone", url, dir], dirname(dir));
}

/**
 * Initialize git repo in backup directory.
 */
export async function initRepo(dir) {
  await git(["init", "-b", "main"], dir);
  // Persist the same settings in the repo so manual `git` use in the backup
  // dir behaves identically (long paths on Windows, no line-ending rewrites).
  try { await git(["config", "core.longpaths", "true"], dir); } catch {}
  try { await git(["config", "core.autocrlf", "false"], dir); } catch {}
}

/**
 * Check if remote is configured.
 */
export async function hasRemote(dir) {
  try {
    const { stdout } = await git(["remote"], dir);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Add remote origin.
 */
export async function addRemote(dir, url) {
  await git(["remote", "add", "origin", url], dir);
}

/**
 * Get current remote URL.
 */
export async function getRemoteUrl(dir) {
  try {
    const { stdout } = await git(["remote", "get-url", "origin"], dir);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Parse a GitHub remote URL into "owner/repo", or null if not GitHub. */
export function parseGitHubSlug(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Determine whether the backup remote is public — the tool's whole point is to
 * back up ~/.claude, which holds secrets (MCP API keys, settings.local.json,
 * session transcripts), so backups must go to a PRIVATE repo.
 *
 * Returns { state: "none"|"private"|"public"|"unknown", slug?, url? }.
 * "unknown" when the remote isn't GitHub or gh can't verify it — we don't block
 * those (a legitimate private SSH remote is common), only warn.
 */
export async function getRemoteVisibility(dir) {
  const url = await getRemoteUrl(dir);
  if (!url) return { state: "none" };
  const slug = parseGitHubSlug(url);
  if (!slug || !(await ghAvailable())) return { state: "unknown", url, slug: slug || undefined };
  try {
    const { stdout } = await exec("gh", ["repo", "view", slug, "--json", "visibility", "-q", ".visibility"], { timeout: 15_000 });
    const v = stdout.trim().toUpperCase();
    return { state: v === "PUBLIC" ? "public" : v === "PRIVATE" ? "private" : "unknown", slug, url };
  } catch {
    return { state: "unknown", slug, url };
  }
}

/**
 * Stage all changes, commit, and push.
 * @param {string} dir
 * @param {{ allowPublic?: boolean }} [opts]  bypass the public-remote guard
 * Returns { committed, pushed, blocked?, message }
 */
export async function commitAndPush(dir, opts = {}) {
  // Stage everything
  await git(["add", "-A"], dir);

  // Check if there are changes to commit
  try {
    await git(["diff", "--cached", "--quiet"], dir);
    // If diff --quiet succeeds, no changes
    return { committed: false, pushed: false, message: "No changes to backup" };
  } catch {
    // Changes exist — commit
  }

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const commitMsg = `backup: ${ts}`;
  await git(["commit", "-m", commitMsg], dir);

  // Push if remote exists
  if (await hasRemote(dir)) {
    // Guard: never push a ~/.claude backup to a PUBLIC repo — it can contain
    // MCP API keys, settings.local.json, and session transcripts.
    const vis = await getRemoteVisibility(dir);
    if (vis.state === "public" && !opts.allowPublic) {
      return {
        committed: true, pushed: false, blocked: true,
        message:
          `Refusing to push: backup remote ${vis.slug || ""} is PUBLIC.\n` +
          `  Your backup can contain secrets (MCP keys, settings.local.json, sessions).\n` +
          `  Point origin at a PRIVATE repo, or re-run with --allow-public to override.`,
      };
    }
    // Sync with other machines first: rebase our env-dir commit on top of any
    // changes they pushed. Machines touch disjoint latest/<envId>/ dirs, so this
    // is normally conflict-free, and on the first push origin/main doesn't exist
    // yet (a benign failure). But a REAL conflict leaves the worktree mid-rebase;
    // pushing then would commit an inconsistent state and falsely report success.
    let syncNote = "";
    try {
      await git(["pull", "--rebase", "origin", "main"], dir);
    } catch (err) {
      const inRebase =
        (await pathExists(join(dir, ".git", "rebase-merge"))) ||
        (await pathExists(join(dir, ".git", "rebase-apply")));
      if (inRebase) {
        // Abort to restore a clean worktree, then refuse to push.
        try { await git(["rebase", "--abort"], dir); } catch {}
        return {
          committed: true, pushed: false, blocked: "rebase-conflict",
          message:
            `Committed, but NOT pushed: rebasing onto origin/main hit a conflict.\n` +
            `  Another machine pushed overlapping changes. The rebase was aborted to\n` +
            `  keep your local backup intact. In ${dir} run 'git pull --rebase',\n` +
            `  resolve the conflict, then re-run the backup.`,
        };
      }
      // No rebase state. Either a benign first push (origin/main doesn't exist
      // yet) or a real sync failure (network/auth). If a remote-tracking main
      // exists, the sync genuinely failed — warn rather than swallow silently.
      let remoteMainExists = false;
      try { await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], dir); remoteMainExists = true; } catch {}
      if (remoteMainExists) syncNote = " (warning: could not sync with origin before pushing)";
    }
    try {
      await git(["push", "-u", "origin", "main"], dir);
      let message = `Committed and pushed: ${commitMsg}`;
      if (vis.state === "unknown") message += " (note: could not verify the remote is private)";
      message += syncNote;
      return { committed: true, pushed: true, message };
    } catch (err) {
      return { committed: true, pushed: false, message: `Committed but push failed: ${err.message}` };
    }
  }

  return { committed: true, pushed: false, message: `Committed (no remote): ${commitMsg}` };
}
