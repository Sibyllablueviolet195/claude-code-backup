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
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createInterface } from "node:readline";

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
  const { isGitRepo, initRepo, addRemote } = await import("../src/git-sync.mjs");
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

  // Create backup directory
  await mkdir(BACKUP_DIR, { recursive: true });

  // Git repo setup
  if (!(await isGitRepo(BACKUP_DIR))) {
    log("Initializing git repo in ~/.claude-backups/");
    await initRepo(BACKUP_DIR);

    // Write .gitignore
    await writeFile(
      join(BACKUP_DIR, ".gitignore"),
      [
        "# Don't track timestamped backups — only latest/",
        "backup-*/",
        "*.log",
        "config.json",
        "",
      ].join("\n")
    );

    // Treat every backed-up file as binary: never normalize line endings, so
    // backups are byte-faithful and restores match the originals exactly.
    await writeFile(
      join(BACKUP_DIR, ".gitattributes"),
      ["* -text", ""].join("\n")
    );
  }

  // Remote setup
  const { hasRemote, getRemoteUrl } = await import("../src/git-sync.mjs");
  if (await hasRemote(BACKUP_DIR)) {
    const url = await getRemoteUrl(BACKUP_DIR);
    log(`Git remote already configured: ${url}`);
    const change = await ask("Change remote? (y/N): ");
    if (change.toLowerCase() === "y") {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const newUrl = await ask("GitHub repo URL (SSH or HTTPS): ");
      await exec("git", ["remote", "set-url", "origin", newUrl], { cwd: BACKUP_DIR });
      log(`Remote updated to: ${newUrl}`);
    }
  } else {
    const { ghAvailable, ghAuthedUser, ghCreateRepo } = await import("../src/git-sync.mjs");
    let configured = false;

    // Offer to create the private repo automatically via the gh CLI (HTTPS).
    if (await ghAvailable()) {
      const ghUser = await ghAuthedUser();
      if (ghUser) {
        const sanitizedHost = (process.env.COMPUTERNAME || process.env.HOSTNAME || "machine")
          .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "machine";
        const defaultName = `claude-backup-${sanitizedHost}`;
        const create = await ask(`Create a private GitHub repo with gh (as ${ghUser})? (Y/n): `);
        if (create.toLowerCase() !== "n") {
          const nameAns = await ask(`Repo name (default: ${defaultName}): `);
          const repoName = nameAns || defaultName;
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
        // Warn immediately if we can tell the repo is public.
        const { getRemoteVisibility } = await import("../src/git-sync.mjs");
        const vis = await getRemoteVisibility(BACKUP_DIR);
        if (vis.state === "public") {
          log(`⚠️  WARNING: ${vis.slug} is PUBLIC. Backups will be blocked until you switch to a private repo (or use --allow-public).`);
        }
      } else {
        log("Skipping remote setup. Run 'git remote add origin <url>' in ~/.claude-backups/ later.");
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

  // Run first backup
  log("\nRunning first backup...\n");
  await cmdRun();

  log("\n✓ Setup complete! Your Claude Code settings are backed up.");
  log("  Backup location: ~/.claude-backups/latest/");
  log(`  Auto-backup: every ${interval} hours + on boot`);
}

async function cmdRun() {
  const { exportLatest } = await import("../src/exporter.mjs");
  const { commitAndPush } = await import("../src/git-sync.mjs");

  // Interactive runs wake stopped WSL distros to back them up; scheduled
  // (--quiet) runs leave them asleep and capture WSL only when it's running.
  const startStopped = !process.argv.includes("--quiet");

  log("Scanning and exporting...");
  const { backupRoot, copied, errors, summary, environments } = await exportLatest(BACKUP_DIR, { startStopped });

  if (environments && environments.length > 1) {
    log(`Environments: ${environments.map((e) => e.id).join(", ")}`);
  }
  log(`Exported ${copied} items to ${backupRoot}`);
  if (errors.length > 0) {
    log(`Warnings: ${errors.length} items failed to export`);
    for (const err of errors.slice(0, 5)) log(`  - ${err}`);
  }

  // Git commit + push (backups must go to a private repo — see the guard below)
  log("Committing...");
  const result = await commitAndPush(BACKUP_DIR, { allowPublic: process.argv.includes("--allow-public") });
  log(result.message);

  // Write last-run info
  await saveConfig({
    ...(await loadConfig()),
    lastRun: new Date().toISOString(),
    lastCopied: copied,
    lastErrors: errors.length,
  });
}

async function cmdStatus() {
  const { status } = await import("../src/scheduler.mjs");
  const config = await loadConfig();

  if (config.lastRun) {
    const ago = Math.round((Date.now() - new Date(config.lastRun).getTime()) / 60000);
    log(`Last backup: ${config.lastRun} (${ago} min ago)`);
    log(`  Items backed up: ${config.lastCopied || "unknown"}`);
    log(`  Errors: ${config.lastErrors || 0}`);
  } else {
    log("No backup has been run yet.");
  }

  // Show which environments the last backup captured.
  try {
    const idx = JSON.parse(await readFile(join(BACKUP_DIR, "latest", "backup-summary.json"), "utf-8"));
    if (idx.environments?.length) {
      log(`  Environments: ${idx.environments.map((e) => e.id).join(", ")}`);
    }
  } catch {}

  log("\nScheduler status:");
  const s = await status();
  log(s);

  // Check git status
  const { isGitRepo, hasRemote, getRemoteUrl } = await import("../src/git-sync.mjs");
  if (await isGitRepo(BACKUP_DIR)) {
    log("\nGit repo: ~/.claude-backups/");
    if (await hasRemote(BACKUP_DIR)) {
      log(`Remote: ${await getRemoteUrl(BACKUP_DIR)}`);
    } else {
      log("Remote: not configured");
    }
  } else {
    log("\nGit repo: not initialized. Run 'claude-code-backup init' first.");
  }
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

async function cmdRestore() {
  const { restore } = await import("../src/restorer.mjs");
  const apply = process.argv.includes("--apply");
  const opts = {
    apply,
    from: argValue("--from"),
    to: argValue("--to"),
    scope: argValue("--scope"),
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

  log("");
  log(`${apply ? "Restored" : "Would restore"}: ${result.restored} files/dirs, ${result.merged} MCP merges, ${result.skipped} skipped`);
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
    log("  claude-code-backup status      Show backup status");
    log("  claude-code-backup restore     Restore from backup (dry-run; add --apply)");
    log("  claude-code-backup uninstall   Remove scheduled backup\n");
    log("  restore flags: --apply  --from <envId>  --to <envId>  --scope <id>  --verbose");
    log("Backs up Windows-native AND WSL stores; restores across machines and OSes.");
    break;
}
