/**
 * exporter.mjs — Export all scanned Claude Code items to a backup directory.
 *
 * Discovers every reachable environment (Windows-native + WSL distros, or a
 * single native store on Linux/macOS), scans each, and writes them under
 * per-environment prefixes when more than one is present:
 *
 *   latest/<envId>/<scopeId>/<category>/<file>      (multi-environment)
 *   latest/<scopeId>/<category>/<file>              (single environment)
 *
 * Each environment dir also gets an env.json (identity) and a manifest.json
 * (per-item originalPath/repoRoot/isDir) so `restore` can map files back to
 * their real locations on any machine, including cross-OS.
 */

import { mkdir, copyFile, writeFile, cp, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { scan } from "./scanner.mjs";
import { discoverEnvironments } from "./environments.mjs";

const BACKUP_DIR = join(homedir(), ".claude-backups");

/**
 * Convert a path the current process used to READ a store into the path the
 * store itself sees natively. For a WSL store reached over UNC
 * (\\wsl.localhost\Ubuntu\home\u\…) this strips the UNC root and flips
 * separators → /home/u/…. Native stores pass through unchanged.
 */
function toNativePath(p, env) {
  if (!p) return p;
  if (env.accessVia === "unc" && env.uncRoot && p.startsWith(env.uncRoot)) {
    return p.slice(env.uncRoot.length).replace(/\\/g, "/") || "/";
  }
  return p;
}

/** Items that aren't backed up as files — already captured inside "config". */
function isExportable(item) {
  return item.category !== "setting" && item.category !== "hook";
}

/**
 * Copy one scanned environment's items into `envBase`, returning the manifest
 * entries plus copy stats. Mirrors the destination-name logic so manifest
 * backupPaths match what lands on disk.
 */
async function exportEnvItems(data, env, envBase) {
  let copied = 0;
  const errors = [];
  const manifestItems = [];

  // scopeId → native repoRoot (for project-scope restore re-rooting)
  const repoRootByScope = new Map();
  for (const scope of data.scopes) {
    if (scope.repoDir) repoRootByScope.set(scope.id, toNativePath(scope.repoDir, env));
  }

  for (const item of data.items) {
    if (!isExportable(item)) continue;
    try {
      const subDir = join(envBase, item.scopeId, item.category);
      await mkdir(subDir, { recursive: true });

      let relName;          // file/dir name within the category dir
      let isDir = false;

      if (item.category === "skill" || (item.category === "plugin" && item.path)) {
        relName = item.fileName || basename(item.path);
        await cp(item.path, join(subDir, relName), { recursive: true });
        isDir = true;
      } else if (item.category === "mcp") {
        relName = `${item.name}.json`;
        await writeFile(
          join(subDir, relName),
          JSON.stringify({ [item.name]: item.mcpConfig || {} }, null, 2) + "\n"
        );
      } else if (item.path) {
        relName = item.fileName || basename(item.path);
        const dest = join(subDir, relName);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(item.path, dest);
      } else {
        continue;
      }

      const entry = {
        backupPath: [item.scopeId, item.category, relName].join("/"),
        originalPath: toNativePath(item.path, env),
        category: item.category,
        scopeId: item.scopeId,
        isDir,
      };
      if (repoRootByScope.has(item.scopeId)) entry.repoRoot = repoRootByScope.get(item.scopeId);
      if (item.category === "mcp") {
        entry.mcpServerName = item.name;
        entry.hostFile = basename(item.path || "");
        if (item.claudeJsonProjectKey) entry.claudeJsonProjectKey = toNativePath(item.claudeJsonProjectKey, env);
      }
      manifestItems.push(entry);
      copied++;
    } catch (err) {
      errors.push(`${item.category}/${item.name}: ${err.message}`);
    }
  }

  return { copied, errors, manifestItems };
}

/** Write env.json + manifest.json + backup-summary.json for one environment. */
async function writeEnvMetadata(envBase, env, data, manifestItems, copied, errors) {
  const { id, kind, distro, home, claudeDir, osPlatform, accessVia } = env;
  await writeFile(
    join(envBase, "env.json"),
    JSON.stringify({ id, kind, distro, home, claudeDir, osPlatform, accessVia }, null, 2) + "\n"
  );
  await writeFile(
    join(envBase, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      env: { id, kind, distro, home, claudeDir, osPlatform },
      items: manifestItems,
    }, null, 2) + "\n"
  );
  const summary = {
    exportedAt: new Date().toISOString(),
    envId: id,
    copied,
    errors: errors.length,
    errorDetails: errors.length > 0 ? errors : undefined,
    scopes: data.scopes.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    categories: [...new Set(manifestItems.map((i) => i.category))],
    counts: data.counts,
  };
  await writeFile(join(envBase, "backup-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

/**
 * Core export routine: discover environments, scan each, copy + write metadata.
 * @param {string} rootDir   directory that receives the per-env (or flat) tree
 * @param {object} opts      { startStopped }
 */
async function exportToRoot(rootDir, opts = {}) {
  const environments = await discoverEnvironments({ startStopped: opts.startStopped });
  const multiEnv = environments.length > 1;

  let copied = 0;
  const errors = [];
  const envSummaries = [];

  for (const env of environments) {
    const data = await scan(env);                 // sequential — avoids UNC/local 9p contention
    const envBase = multiEnv ? join(rootDir, env.id) : rootDir;
    await mkdir(envBase, { recursive: true });

    const r = await exportEnvItems(data, env, envBase);
    copied += r.copied;
    for (const e of r.errors) errors.push(`[${env.id}] ${e}`);
    const summary = await writeEnvMetadata(envBase, env, data, r.manifestItems, r.copied, r.errors);
    envSummaries.push({ envId: env.id, kind: env.kind, copied: r.copied, errors: r.errors.length, counts: data.counts });
  }

  // Top-level index so status/tooling sees the whole picture at a glance.
  const summary = {
    exportedAt: new Date().toISOString(),
    multiEnv,
    environments: environments.map((e) => ({ id: e.id, kind: e.kind, distro: e.distro })),
    copied,
    errors: errors.length,
    errorDetails: errors.length > 0 ? errors : undefined,
    envSummaries,
  };
  await writeFile(join(rootDir, "backup-summary.json"), JSON.stringify(summary, null, 2) + "\n");

  return { copied, errors, summary, environments };
}

/**
 * Export to a timestamped directory (historical snapshot). Not used by the
 * scheduler; kept for ad-hoc full snapshots.
 */
export async function exportAll(backupDir = BACKUP_DIR, opts = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupRoot = join(backupDir, `backup-${ts}`);
  await mkdir(backupRoot, { recursive: true });
  const { copied, errors, summary, environments } = await exportToRoot(backupRoot, opts);
  return { backupRoot, copied, errors, summary, environments };
}

/**
 * Export to a stable "latest/" directory (for git tracking). Overwrites the
 * previous export so git only stores the diff.
 */
export async function exportLatest(backupDir = BACKUP_DIR, opts = {}) {
  const latestDir = join(backupDir, "latest");
  try { await rm(latestDir, { recursive: true, force: true }); } catch {}
  await mkdir(latestDir, { recursive: true });
  const { copied, errors, summary, environments } = await exportToRoot(latestDir, opts);
  return { backupRoot: latestDir, copied, errors, summary, environments };
}
