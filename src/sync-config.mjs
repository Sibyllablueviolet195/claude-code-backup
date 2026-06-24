/**
 * sync-config.mjs — Opt-in sync groups + cross-group leak guard (M2).
 *
 * One private repo holds every machine, so `restore` could copy one machine's
 * config (e.g. WORK MCP keys) onto another (HOME) — a leak. A sync group is a
 * LOCAL, per-machine declaration of which machines may share config. Until the
 * user creates ~/.claude-backups/sync-config.json with groups, the guard is OFF
 * and restore behaves exactly as before (opt-in).
 *
 * sync-config.json shape:
 *   { "machineUuid": "<this machine>",
 *     "groups": [
 *       { "id": "windows-shared", "members": ["<uuidA>","<uuidB>"],
 *         "direction": "bidirectional",
 *         "exclude": { "categories": ["session"], "labels": ["sensitive"] } },
 *       { "id": "home-linux", "members": ["<uuidC>"], "direction": "isolated" }
 *     ] }
 *
 * It is LOCAL state (gitignored): each machine controls what it will accept.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadSyncConfig(backupDir) {
  try { return JSON.parse(await readFile(join(backupDir, "sync-config.json"), "utf-8")); }
  catch { return null; }
}

/** This machine's UUID, read (not created) from machine-id.json, or null. */
export async function localMachineUuid(backupDir) {
  try { return JSON.parse(await readFile(join(backupDir, "machine-id.json"), "utf-8")).uuid || null; }
  catch { return null; }
}

/**
 * The leak guard. Returns { allowed, reason?, exclude? }.
 *
 * Opt-in: when NO groups are configured the guard is entirely off (allowed) —
 * the common new-machine restore keeps working. But once the user HAS declared
 * groups, it fails CLOSED: a same-machine restore is allowed, and a cross-machine
 * restore is allowed only when both machines are members of the same group. An
 * unidentifiable machine (missing UUID — e.g. a pre-v0.5.0 backup, or a machine
 * with no identity yet) is REFUSED rather than silently let through, so the
 * declared isolation can't be bypassed.
 */
export function restoreAllowed(srcUuid, destUuid, config) {
  const groups = config?.groups;
  if (!groups?.length) return { allowed: true };           // opt-in: guard off
  if (srcUuid && destUuid && srcUuid === destUuid) return { allowed: true };   // same machine
  if (!srcUuid) return { allowed: false, reason: "source backup has no machine UUID (pre-v0.5.0 or unidentified) — add it to a sync group to allow" };
  if (!destUuid) return { allowed: false, reason: "this machine has no identity yet (run a backup once) to evaluate sync groups" };
  const shared = groups.find((g) => Array.isArray(g.members) && g.members.includes(srcUuid) && g.members.includes(destUuid));
  if (shared) return { allowed: true, exclude: shared.exclude };
  return { allowed: false, reason: "source and destination machines are not in a shared sync group" };
}
