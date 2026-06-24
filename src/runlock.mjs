/**
 * runlock.mjs — Per-machine run lock + local-state gitignore guard.
 *
 * Two concerns that both protect the shared backup repo from this machine:
 *  - acquireLock/releaseLock serialize `run`s so a scheduled run and a manual
 *    one can't export/commit concurrently and clobber each other (C6).
 *  - ensureLocalIgnores keeps per-machine LOCAL state (machine-id.json identity,
 *    the .lock file) out of git — committing machine-id.json would make other
 *    machines' clones adopt this machine's UUID and collide.
 */

import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const LOCAL_IGNORES = ["machine-id.json", ".lock"];

// A backup run finishes in well under this; any lock older than it is stale.
// This bounds the worst case (a crashed run whose PID was recycled — common on
// Windows) so the lock can never wedge backups indefinitely.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;   // 30 minutes

/** Is a process with this PID still running? (EPERM = exists but not ours.) */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/** True if the lock file is older than the max run age (and thus safe to steal). */
async function lockExpired(lockPath) {
  try { return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_MAX_AGE_MS; }
  catch { return true; }   // can't stat → treat as gone
}

/**
 * Acquire the per-machine run lock. Returns true on success, false if another
 * LIVE run already holds it. A lock left by a dead process is treated as stale,
 * cleared, and re-acquired.
 */
export async function acquireLock(backupDir) {
  const lockPath = join(backupDir, ".lock");
  await mkdir(backupDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let pid = 0;
      try { pid = parseInt(await readFile(lockPath, "utf-8"), 10); } catch {}
      // Held by a live PID AND not yet expired → a real concurrent run. Otherwise
      // it's stale (dead PID, or a recycled PID on an old lock) → clear & retry.
      if (pid && pidAlive(pid) && !(await lockExpired(lockPath))) return false;
      try { await rm(lockPath, { force: true }); } catch {}
    }
  }
  return false;
}

export async function releaseLock(backupDir) {
  try { await rm(join(backupDir, ".lock"), { force: true }); } catch {}
}

/** Idempotently add LOCAL_IGNORES to <backupDir>/.gitignore (covers upgraded repos). */
export async function ensureLocalIgnores(backupDir) {
  const file = join(backupDir, ".gitignore");
  let current = "";
  try { current = await readFile(file, "utf-8"); } catch {}
  const lines = current.split(/\r?\n/);
  const missing = LOCAL_IGNORES.filter((entry) => !lines.includes(entry));
  if (!missing.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(file, current + prefix + missing.join("\n") + "\n");
}
