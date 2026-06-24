#!/usr/bin/env node

/**
 * claude-code-backup CLI
 *
 * Commands:
 *   init          — Interactive setup: create backup repo, configure remote, install scheduler
 *   run           — Run a backup now (scan + export + commit + push)
 *   status        — Show last backup info and scheduler status
 *   uninstall     — Remove scheduled backup (keeps backup data)
 */

import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, access, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { acquireLock, releaseLock, ensureLocalIgnores, LOCAL_IGNORES } from "../src/runlock.mjs";
import { renderMachineLines, formatAge, isStale, renderCheck, tallyChecks, parseYesNo, chooseIndex, metaParen } from "../src/cli-ui.mjs";

const HOME = homedir();
const BACKUP_DIR = join(HOME, ".claude-backups");
const CONFIG_PATH = join(BACKUP_DIR, "config.json");

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  if (!process.argv.includes("--quiet")) {
    process.stdout.write(msg + "\n");
  }
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Recursively sum the byte size of a directory tree (best-effort; skips unreadable entries). */
async function dirBytes(dir) {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirBytes(p);
      else { total += (await stat(p)).size; }
    } catch {}
  }
  return total;
}

/** Prompt once for this machine's label + role; persist them in machine-id.json. */
async function ensureMachineIdentity() {
  const { persistedMachineIdentity } = await import("../src/environments.mjs");
  let existing;
  try { existing = JSON.parse(await readFile(join(BACKUP_DIR, "machine-id.json"), "utf-8")); } catch {}
  if (existing?.uuid) {
    log(`This machine: ${existing.label} (role: ${existing.role})`);
    return existing;
  }
  const host = hostname() || "machine";
  const label = (await ask(`Label for this machine [${host}]: `)).trim() || host;
  const roleAns = (await ask("Role: [1] work  [2] home  [3] shared (3): ")).trim();
  const role = roleAns === "1" ? "work" : roleAns === "2" ? "home" : "shared";
  const identity = await persistedMachineIdentity(BACKUP_DIR, { label, role });
  log(`This machine: ${identity.label} (role: ${identity.role})`);
  return identity;
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await mkdir(BACKUP_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdInit() {
  const { scan } = await import("../src/scanner.mjs");
  const {
    isGitRepo, initRepo, addRemote, hasRemote, getRemoteUrl, cloneRepo,
    ghAvailable, ghAuthedUser, ghCreateRepo, getRemoteVisibility,
  } = await import("../src/git-sync.mjs");
  const { install } = await import("../src/scheduler.mjs");
  const { discoverEnvironments } = await import("../src/environments.mjs");

  log("🔍 Scanning Claude Code settings...\n");

  // Discover every reachable environment (Windows-native + WSL distros, or a
  // single native store). init is interactive, so wake stopped WSL distros.
  const environments = await discoverEnvironments({ startStopped: true });
  if (environments.length > 1) {
    log(`Found ${environments.length} Claude Code environments:`);
    for (const e of environments) log(`  ${e.id}${e.kind === "wsl" ? "  (WSL — backed up over UNC)" : ""}`);
    log("");
  }

  const data = await scan();
  const scopeCount = data.scopes.length;
  const itemCount = data.items.length;

  log(`Found ${itemCount} items across ${scopeCount} scopes (${environments[0].id}):`);
  for (const [cat, count] of Object.entries(data.counts)) {
    if (cat === "total") continue;
    log(`  ${cat}: ${count}`);
  }
  log("");

  // ── Repo + remote setup ──────────────────────────────────────────
  // One private repo holds EVERY machine, separated by per-environment
  // folders (latest/<envId>/) whose names embed the hostname. So the repo
  // itself is machine-agnostic: the first machine CREATES it, and later
  // machines JOIN by cloning it (sharing history so pushes don't clobber).

  async function writeRepoMeta() {
    await writeFile(
      join(BACKUP_DIR, ".gitignore"),
      [
        "# Don't track timestamped backups — only latest/", "backup-*/", "*.log", "config.json",
        "# Per-machine LOCAL state — must never be shared between machines",
        ...LOCAL_IGNORES, "",
      ].join("\n")
    );
    // Treat every backed-up file as binary: never normalize line endings, so
    // backups are byte-faithful and restores match the originals exactly.
    await writeFile(join(BACKUP_DIR, ".gitattributes"), ["* -text", ""].join("\n"));
  }

  async function warnIfPublic() {
    const vis = await getRemoteVisibility(BACKUP_DIR);
    if (vis.state === "public") {
      log(`⚠️  WARNING: ${vis.slug} is PUBLIC. Backups will be blocked until it's private (or you pass --allow-public).`);
    }
  }

  if ((await isGitRepo(BACKUP_DIR)) && (await hasRemote(BACKUP_DIR))) {
    log(`Existing backup repo: ${await getRemoteUrl(BACKUP_DIR)}`);
    await warnIfPublic();
  } else {
    log("Set up the backup repo (one private repo holds every machine):");
    log("  [1] First machine  — create a new private repo");
    log("  [2] Join existing  — clone the repo another machine already uses");
    const mode = (await ask("Choose 1 or 2 (default 1): ")).trim();

    if (mode === "2") {
      // JOIN — clone so we share history and only manage our own env dirs.
      let url = await ask("Existing backup repo URL (SSH or HTTPS): ");
      if (!url && (await ghAvailable())) {
        const u = await ghAuthedUser();
        if (u) {
          const guess = `https://github.com/${u}/claude-backup.git`;
          if ((await ask(`Use ${guess}? (Y/n): `)).toLowerCase() !== "n") url = guess;
        }
      }
      if (!url) { log("No repo URL given — aborting. Re-run init when ready."); return; }
      if (await exists(BACKUP_DIR)) {
        log("~/.claude-backups already exists, so it can't be cloned into. Move/remove it and re-run init.");
        return;
      }
      try {
        await cloneRepo(url, BACKUP_DIR);
        log("Cloned existing backup into ~/.claude-backups/");
      } catch (err) {
        log(`Clone failed: ${err.message}`);
        return;
      }
      await warnIfPublic();
    } else {
      // CREATE — new repo for the first machine.
      await mkdir(BACKUP_DIR, { recursive: true });
      if (!(await isGitRepo(BACKUP_DIR))) {
        log("Initializing git repo in ~/.claude-backups/");
        await initRepo(BACKUP_DIR);
        await writeRepoMeta();
      }

      let configured = false;
      if (await ghAvailable()) {
        const ghUser = await ghAuthedUser();
        if (ghUser) {
          const create = await ask(`Create a private GitHub repo with gh (as ${ghUser})? (Y/n): `);
          if (create.toLowerCase() !== "n") {
            const nameAns = await ask("Repo name (default: claude-backup): ");
            const repoName = nameAns || "claude-backup";
            try {
              const url = await ghCreateRepo(repoName);
              await addRemote(BACKUP_DIR, url);
              log(`Created and linked: ${url}`);
              configured = true;
            } catch (err) {
              log(`gh repo create failed (${err.message}). Falling back to manual setup.`);
            }
          }
        }
      }

      if (!configured) {
        log("Use a PRIVATE repo — backups can contain secrets (MCP keys, settings.local.json, sessions).");
        const repoUrl = await ask("GitHub repo URL (e.g. git@github.com:you/claude-backup.git): ");
        if (repoUrl) {
          await addRemote(BACKUP_DIR, repoUrl);
          log(`Remote added: ${repoUrl}`);
          await warnIfPublic();
        } else {
          log("Skipping remote setup. Run 'git remote add origin <url>' in ~/.claude-backups/ later.");
        }
      }
    }
  }

  // Scheduler setup
  log("");
  const intervalStr = await ask("Backup interval in hours (default: 4): ");
  const interval = parseInt(intervalStr) || 4;

  const nodePath = process.execPath;
  const cliPath = fileURLToPath(import.meta.url);

  try {
    const result = await install(nodePath, cliPath, interval);
    log(`\nScheduler installed (every ${interval}h + on boot)`);
    if (result.timerPath) log(`  Service: ${result.timerPath}`);
    if (result.plistPath) log(`  LaunchAgent: ${result.plistPath}`);
    if (result.taskName) log(`  Scheduled task: ${result.taskName}`);
  } catch (err) {
    log(`\nFailed to install scheduler: ${err.message}`);
    log("You can run backups manually with: npx @seangsisg/claude-code-backup run");
  }

  // Save config
  await saveConfig({ interval, installedAt: new Date().toISOString() });

  // Machine identity (label + role) — stamped into env.json and shown wherever
  // machines are listed (status/list). Prompted once; persisted locally.
  log("");
  await ensureMachineIdentity();

  // Run first backup
  log("\nRunning first backup...\n");
  await cmdRun();

  log("\n✓ Setup complete! Your Claude Code settings are backed up.");
  log("  Backup location: ~/.claude-backups/latest/");
  log(`  Auto-backup: every ${interval} hours + on boot`);
}

async function cmdRun() {
  // Serialize runs so a scheduled run and a manual one can't race (C6).
  if (!(await acquireLock(BACKUP_DIR))) {
    log("Another backup is already running (lock held) — skipping this run.");
    process.exitCode = 1;
    return;
  }
  try {
    await cmdRunLocked();
  } finally {
    await releaseLock(BACKUP_DIR);
  }
}

async function cmdRunLocked() {
  const { exportLatest } = await import("../src/exporter.mjs");
  const { commitAndPush } = await import("../src/git-sync.mjs");

  // Interactive runs wake stopped WSL distros to back them up; scheduled
  // (--quiet) runs leave them asleep and capture WSL only when it's running.
  const startStopped = !process.argv.includes("--quiet");

  log("Scanning and exporting...");
  let exported;
  try {
    exported = await exportLatest(BACKUP_DIR, {
      startStopped,
      confirmCollision: process.argv.includes("--confirm-collision"),
    });
  } catch (err) {
    log(`\n✗ Backup aborted: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const { backupRoot, copied, excluded, errors, summary, environments } = exported;

  if (environments && environments.length > 1) {
    log(`Environments: ${environments.map((e) => e.id).join(", ")}`);
  }
  log(`Exported ${copied} items to ${backupRoot}`);
  if (excluded > 0) log(`Excluded ${excluded} item(s) per exclude.json`);
  if (errors.length > 0) {
    log(`Warnings: ${errors.length} items failed to export`);
    for (const err of errors.slice(0, 5)) log(`  - ${err}`);
  }

  // C5: heuristic secret scan over THIS run's exported data — a non-blocking
  // private-repo reminder. The backup intentionally keeps secrets; we never drop
  // them, we just remind the user to keep the remote private and rotate leaks.
  try {
    const { scanForSecrets, secretWarning } = await import("../src/secret-scan.mjs");
    const dirs = (environments || []).map((e) => join(backupRoot, e.id));
    const { hits } = await scanForSecrets(dirs);
    const warning = secretWarning(hits);
    if (warning) log(warning);
  } catch {}

  // Keep per-machine local state (identity, lock) out of the shared repo.
  await ensureLocalIgnores(BACKUP_DIR);

  // Git commit + push (backups must go to a private repo — see the guard below)
  log("Committing...");
  const result = await commitAndPush(BACKUP_DIR, { allowPublic: process.argv.includes("--allow-public") });
  log(result.message);
  // A blocked push (public-remote guard or rebase conflict) committed locally but
  // did NOT reach the remote — exit non-zero so scheduled runs surface it.
  if (result.blocked) process.exitCode = 1;

  // Write last-run info
  await saveConfig({
    ...(await loadConfig()),
    lastRun: new Date().toISOString(),
    lastCopied: copied,
    lastErrors: errors.length,
  });
}

async function cmdList() {
  const { readBackupIndex } = await import("../src/exporter.mjs");
  const { localMachineUuid } = await import("../src/sync-config.mjs");

  let environments = [];
  try {
    ({ environments } = await readBackupIndex(join(BACKUP_DIR, "latest")));
  } catch (err) {
    // readBackupIndex tolerates a missing dir (returns []); a throw here is a
    // genuine fault (corrupt JSON, unreadable repo) — surface it, don't mask it.
    log(`Could not read backup index: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!environments.length) {
    log("No backups found in ~/.claude-backups/latest/.");
    log("Run 'claude-code-backup init' (first time) or 'claude-code-backup run' to create one.");
    return;
  }

  const thisUuid = await localMachineUuid(BACKUP_DIR);
  log("Machines in backup:");
  for (const line of renderMachineLines(environments, { thisUuid, nowMs: Date.now() })) {
    log(line);
  }
}

async function cmdStatus() {
  const { status: schedStatus } = await import("../src/scheduler.mjs");
  const { readBackupIndex } = await import("../src/exporter.mjs");
  const { localMachineUuid } = await import("../src/sync-config.mjs");
  const { isGitRepo, hasRemote, getRemoteUrl, getRemoteVisibility, getBranchSync } =
    await import("../src/git-sync.mjs");

  const config = await loadConfig();
  const interval = config.interval || 4;
  const latestDir = join(BACKUP_DIR, "latest");
  const warnings = [];

  log("claude-code-backup — status\n");

  // ── Repo + remote + visibility (C5: re-verify every status; a repo can be
  //    flipped public after init, and the backup holds secrets) ────────────
  const isRepo = await isGitRepo(BACKUP_DIR);
  if (!isRepo) {
    log(`Repo:   ${BACKUP_DIR}  (not initialized — run 'claude-code-backup init')`);
  } else if (await hasRemote(BACKUP_DIR)) {
    const url = await getRemoteUrl(BACKUP_DIR);
    const vis = await getRemoteVisibility(BACKUP_DIR);
    const visTag = vis.state === "private" ? "(private ✓)"
      : vis.state === "public" ? "(PUBLIC ⚠)"
      : "(visibility unknown)";
    log(`Repo:   ${BACKUP_DIR}  →  ${url}  ${visTag}`);
    if (vis.state === "public") {
      warnings.push("Remote is PUBLIC — backups are BLOCKED until it's private (or pass --allow-public). Rotate any exposed secrets.");
    } else if (vis.state === "unknown") {
      warnings.push("Remote visibility could not be verified — ensure it's private; the backup holds secrets.");
    }
  } else {
    log(`Repo:   ${BACKUP_DIR}  (no remote configured)`);
    warnings.push("No remote configured — backups stay local only. Run 'init' to link a private repo.");
  }

  if (isRepo) {
    const bs = await getBranchSync(BACKUP_DIR);
    if (bs.branch) {
      const div = bs.hasUpstream ? `${bs.ahead} ahead / ${bs.behind} behind` : "no upstream yet";
      log(`Branch: ${bs.branch}  ·  ${div}  ·  ${bs.dirty} uncommitted`);
      if (bs.hasUpstream && bs.ahead > 0) warnings.push(`${bs.ahead} local commit(s) not pushed to origin.`);
    }
  }

  // ── Machines in backup (scan env dirs — race-free, C6) ───────────────────
  let environments = [];
  try { ({ environments } = await readBackupIndex(latestDir)); } catch {}
  if (environments.length) {
    for (const e of environments) e.bytes = await dirBytes(join(latestDir, e.id));
    const thisUuid = await localMachineUuid(BACKUP_DIR);
    log("\nMachines in backup:");
    for (const line of renderMachineLines(environments, {
      thisUuid, intervalHours: interval, nowMs: Date.now(), showSize: true, showStale: true,
    })) log(line);
  }

  // ── This machine: scheduler + last run ───────────────────────────────────
  log("\nThis machine:");
  let sched = "";
  try { sched = await schedStatus(); } catch {}
  const installed = sched && !/not installed|not loaded|no such|could not|disabled/i.test(sched);
  log(`  Scheduler: ${installed ? `installed · every ${interval}h` : "not installed (run 'claude-code-backup init')"}`);
  // Power users debugging the scheduler can see the raw OS output with --verbose.
  if (process.argv.includes("--verbose") && sched) {
    for (const line of sched.trimEnd().split("\n")) log(`    | ${line}`);
  }
  if (config.lastRun) {
    log(`  Last run:  ${config.lastCopied ?? "?"} items · ${config.lastErrors || 0} errors · ${formatAge(config.lastRun, Date.now())}`);
  } else {
    log("  Last run:  never");
  }

  // ── Warnings (C2 rebase / C5 secrets+visibility surface here) ────────────
  if (warnings.length) {
    log("\nWarnings:");
    for (const w of warnings) log(`  ⚠ ${w}`);
  }
}

async function cmdDoctor() {
  const { status: schedStatus } = await import("../src/scheduler.mjs");
  const { readBackupIndex } = await import("../src/exporter.mjs");
  const { isGitRepo, hasRemote, getRemoteUrl, getRemoteVisibility, getBranchSync } =
    await import("../src/git-sync.mjs");
  const { localMachineUuid } = await import("../src/sync-config.mjs");

  const config = await loadConfig();
  const interval = config.interval || 4;
  const checks = [];

  log("claude-code-backup — doctor\n");

  // Repo present?
  const isRepo = await isGitRepo(BACKUP_DIR);
  checks.push(isRepo
    ? { level: "ok", label: `Backup repo initialized (${BACKUP_DIR})` }
    : { level: "fail", label: "Backup repo not initialized", hint: "run 'claude-code-backup init'" });

  if (isRepo) {
    // Remote + visibility — the load-bearing safety check (backups hold secrets).
    if (!(await hasRemote(BACKUP_DIR))) {
      checks.push({ level: "warn", label: "No remote configured", hint: "run 'init' to link a PRIVATE repo (backups stay local otherwise)" });
    } else {
      checks.push({ level: "ok", label: `Remote configured (${await getRemoteUrl(BACKUP_DIR)})` });
      const vis = await getRemoteVisibility(BACKUP_DIR);
      if (vis.state === "private") checks.push({ level: "ok", label: "Remote is private" });
      else if (vis.state === "public") checks.push({ level: "fail", label: "Remote is PUBLIC — backups are blocked", hint: "make the repo private (it holds secrets), or run with --allow-public" });
      else checks.push({ level: "warn", label: "Remote visibility could not be verified", hint: "ensure the remote is private; the backup holds secrets" });

      const bs = await getBranchSync(BACKUP_DIR);
      if (bs.hasUpstream && bs.ahead > 0) checks.push({ level: "warn", label: `${bs.ahead} local commit(s) not pushed`, hint: "run 'claude-code-backup run', or 'git push' in the backup dir" });
    }

    // Machine identity (C1) — env dirs and the leak guard depend on it.
    const uuid = await localMachineUuid(BACKUP_DIR);
    checks.push(uuid
      ? { level: "ok", label: "Machine identity present (machine-id.json)" }
      : { level: "warn", label: "No machine identity yet", hint: "run 'init' or a backup to mint machine-id.json" });
  }

  // Scheduler installed?
  let sched = "";
  try { sched = await schedStatus(); } catch {}
  const installed = sched && !/not installed|not loaded|no such|could not|disabled/i.test(sched);
  checks.push(installed
    ? { level: "ok", label: `Scheduler installed (every ${interval}h)` }
    : { level: "warn", label: "Scheduler not installed", hint: "run 'claude-code-backup init' to schedule backups" });

  // Freshness.
  if (!config.lastRun) {
    checks.push({ level: "warn", label: "No backup has run yet", hint: "run 'claude-code-backup run'" });
  } else if (isStale(config.lastRun, interval, Date.now())) {
    checks.push({ level: "warn", label: `Last backup is stale (${formatAge(config.lastRun, Date.now())})`, hint: "run 'claude-code-backup run'" });
  } else {
    checks.push({ level: "ok", label: `Last backup is fresh (${formatAge(config.lastRun, Date.now())})` });
  }

  // Backup index parseable (and how many machines it sees).
  if (isRepo) {
    try {
      const { environments } = await readBackupIndex(join(BACKUP_DIR, "latest"));
      checks.push({ level: "ok", label: `Backup index readable (${environments.length} env dir(s))` });
    } catch (err) {
      checks.push({ level: "fail", label: `Backup index unreadable: ${err.message}`, hint: "a backup may be corrupt; re-run 'claude-code-backup run'" });
    }
  }

  for (const c of checks) log(renderCheck(c));
  const t = tallyChecks(checks);
  log(`\n${t.ok} OK · ${t.warn} warning(s) · ${t.fail} error(s)`);
  if (t.fail > 0) process.exitCode = 1;
}

async function cmdUninstall() {
  const { remove } = await import("../src/scheduler.mjs");
  await remove();
  log("Scheduler removed. Backup data preserved in ~/.claude-backups/");
}

/** Read the value following a flag in argv (e.g. --from <value>). */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Read a comma-separated list flag (e.g. --exclude-categories mcp,session) or null. */
function argList(flag) {
  const v = argValue(flag);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
}

/**
 * One readline interface for a whole interactive flow. Creating a fresh
 * interface per prompt (the `ask` helper) drops buffered input when stdin is a
 * pipe rather than a TTY, so multi-question flows must share one.
 */
function prompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  return {
    // Resolve to "" if stdin closes (EOF / Ctrl-D / piped input runs out) rather
    // than throwing ERR_USE_AFTER_CLOSE — callers treat "" as the safe default
    // (blank = auto, and the apply confirmation defaults to No).
    question: (q) => new Promise((res) => {
      if (closed) return res("");
      let done = false;
      const onClose = () => { if (!done) { done = true; res(""); } };
      rl.once("close", onClose);
      rl.question(q, (a) => { if (!done) { done = true; rl.off("close", onClose); res(a.trim()); } });
    }),
    close: () => { if (!closed) rl.close(); },
  };
}

async function cmdRestoreInteractive() {
  const { restore } = await import("../src/restorer.mjs");
  const { readBackupIndex } = await import("../src/exporter.mjs");
  const { discoverEnvironments } = await import("../src/environments.mjs");

  let environments = [];
  try { ({ environments } = await readBackupIndex(join(BACKUP_DIR, "latest"))); } catch {}
  if (!environments.length) {
    log("No restorable environments found in backup. Run 'claude-code-backup run' first.");
    process.exitCode = 1;
    return;
  }

  const p = prompter();
  try {
    // 1. Pick the SOURCE environment.
    log("Restore (interactive) — pick a SOURCE environment to restore FROM:\n");
    environments.forEach((e, i) =>
      log(`  [${i + 1}] ${e.id}   ${metaParen(e.label, e.role)}   ${e.copied ?? 0} items`));
    const sChoice = chooseIndex(await p.question("\nSource number (blank = all environments): "), environments.length);
    if (sChoice.bad) log(`'${sChoice.bad}' isn't a listed number — using all environments.`);
    const from = sChoice.idx ? environments[sChoice.idx - 1].id : null;
    log(from ? `Source: ${from}` : "Source: all environments (each maps to its best local match)");

    // 2. Pick the DESTINATION environment (local).
    let to = null;
    let dests = [];
    try { dests = await discoverEnvironments({ startStopped: true }); } catch {}
    if (dests.length > 1) {
      log("\nPick a DESTINATION environment to restore INTO:\n");
      dests.forEach((d, i) => log(`  [${i + 1}] ${d.id}`));
      const dChoice = chooseIndex(await p.question("\nDest number (blank = auto best-match): "), dests.length);
      if (dChoice.bad) log(`'${dChoice.bad}' isn't a listed number — using auto best-match.`);
      to = dChoice.idx ? dests[dChoice.idx - 1].id : null;
    } else if (dests.length === 1) {
      log(`\nDestination: ${dests[0].id} (only local environment).`);
    }
    if (to) log(`Destination: ${to}`);

    // 3. Dry-run preview (nothing written).
    log("\n— Dry run (no files written) —");
    const base = { from, to, log };
    let preview;
    try {
      preview = await restore(BACKUP_DIR, { ...base, apply: false });
    } catch (err) {
      log(`\nRestore preview failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    log(`\nWould restore: ${preview.restored} files/dirs, ${preview.merged} MCP merges, ${preview.skipped} skipped`);
    if (preview.refused?.length) log(`Refused by leak guard: ${preview.refused.join(", ")} (add a sync group to allow)`);

    // 4. Confirm, then apply.
    if (!parseYesNo(await p.question("\nApply this restore now? [y/N]: "), false)) {
      log("Aborted — nothing was written.");
      return;
    }
    let force = false;
    if (preview.conflicts?.length) {
      force = parseYesNo(
        await p.question(`\n${preview.conflicts.length} local file(s) are NEWER than the backup. Overwrite them? [y/N]: `), false);
      if (!force) { log("Aborted — local changes kept; nothing was written."); return; }
    }
    let result = await restore(BACKUP_DIR, { ...base, apply: true, force });
    // Conflicts can appear BETWEEN the preview and the apply (a local file changed
    // in the meantime). Rather than the misleading "re-run" advice, ask inline.
    if (result.aborted && !force) {
      const n = result.conflicts?.length ?? 0;
      if (parseYesNo(await p.question(`\n${n} local file(s) changed since the preview (now newer than the backup). Overwrite them? [y/N]: `), false)) {
        result = await restore(BACKUP_DIR, { ...base, apply: true, force: true });
      }
    }
    if (result.aborted) {
      log("\nAborted — local changes kept; nothing was written.");
      process.exitCode = 1;
      return;
    }
    log(`\nRestored: ${result.restored} files/dirs, ${result.merged} MCP merges, ${result.skipped} skipped`);
    if (result.errors.length) {
      log(`Warnings (${result.errors.length}):`);
      for (const e of result.errors.slice(0, 10)) log(`  - ${e}`);
    }
  } finally {
    p.close();
  }
}

async function cmdRestore() {
  if (process.argv.includes("--interactive")) return cmdRestoreInteractive();
  const { restore } = await import("../src/restorer.mjs");
  const apply = process.argv.includes("--apply");
  const opts = {
    apply,
    from: argValue("--from"),
    to: argValue("--to"),
    scope: argValue("--scope"),
    onlyCategories: argList("--only-categories"),
    excludeCategories: argList("--exclude-categories"),
    includeLabels: argList("--include-labels"),
    excludeLabels: argList("--exclude-labels"),
    force: process.argv.includes("--force"),
    verbose: process.argv.includes("--verbose"),
    log,
  };

  if (!apply) log("DRY RUN — no files will be written. Re-run with --apply to restore.\n");

  let result;
  try {
    result = await restore(BACKUP_DIR, opts);
  } catch (err) {
    log(`Restore failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // M5: apply aborted because dest files changed locally since the backup.
  if (result.aborted) {
    log(`\nNothing was restored. ${result.conflicts.length} local file(s) are newer than the backup.`);
    process.exitCode = 1;
    return;
  }

  log("");
  log(`${apply ? "Restored" : "Would restore"}: ${result.restored} files/dirs, ${result.merged} MCP merges, ${result.skipped} skipped`);
  if (result.conflicts?.length) {
    log(`${apply ? "Overwrote" : "Conflicts"}: ${result.conflicts.length} item(s) newer locally than the backup${apply ? " (--force)" : " (use --force to overwrite)"}`);
  }
  for (const p of result.pairs) {
    log(`  ${p.from} → ${p.to}${p.cross ? " (cross-OS)" : ""}`);
  }
  if (result.errors.length) {
    log(`Warnings (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) log(`  - ${e}`);
  }
  if (!apply) log("\nRun again with --apply to perform the restore.");
}

// ── Main ─────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "run":
    await cmdRun();
    break;
  case "status":
    await cmdStatus();
    break;
  case "list":
    await cmdList();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "restore":
    await cmdRestore();
    break;
  case "uninstall":
    await cmdUninstall();
    break;
  default:
    log("claude-code-backup — Automatic backup of all Claude Code settings\n");
    log("Usage:");
    log("  claude-code-backup init        Set up backup repo + schedule");
    log("  claude-code-backup run         Run backup now");
    log("  claude-code-backup status      Show backup status (add --verbose for raw scheduler output)");
    log("  claude-code-backup list        List machines/envs in the backup");
    log("  claude-code-backup doctor      Diagnose repo/remote/scheduler/freshness");
    log("  claude-code-backup restore     Restore from backup (dry-run; add --apply)");
    log("  claude-code-backup uninstall   Remove scheduled backup\n");
    log("  run flags:     --quiet  --allow-public  --confirm-collision");
    log("  restore flags: --interactive  --apply  --from <envId>  --to <envId>  --scope <id>  --force  --verbose");
    log("    selective:   --only-categories a,b  --exclude-categories a,b");
    log("                 --include-labels x,y   --exclude-labels x,y   (e.g. --exclude-labels sensitive)");
    log("Backs up Windows-native AND WSL stores; restores across machines and OSes.");
    break;
}
