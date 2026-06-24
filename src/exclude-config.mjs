/**
 * exclude-config.mjs — Optional per-machine export filter (M4).
 *
 * ~/.claude-backups/exclude.json lets a machine keep certain items OUT of its
 * backup (e.g. keep personal projects off a work machine, or drop sessions /
 * settings.local.json to avoid backing up secrets — this also satisfies C5's
 * opt-in secret-exclusion path). Loaded before the export loop; matched items
 * are never copied or manifested. Local, per-machine state (gitignored).
 *
 * exclude.json shape (all fields optional):
 *   { "excludeScopes":     ["proj-x"],            // by scope id
 *     "excludeCategories": ["session","mcp"],     // by category
 *     "excludePaths":      ["secret*", "*.env"],  // glob on the item's path
 *     "projectFilter": { "mode": "include"|"exclude", "patterns": ["*work*"] } }
 *
 * Globs: `*` matches within one path segment, a double-star matches across
 * directories, `?` matches one non-separator char.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadExcludeConfig(backupDir) {
  try { return JSON.parse(await readFile(join(backupDir, "exclude.json"), "utf-8")); }
  catch { return null; }
}

const norm = (p) => String(p == null ? "" : p).replace(/\\/g, "/");

/** Minimal glob → RegExp: `**` = any, `*` = any except `/`, `?` = one non-`/`. */
export function globToRegExp(glob) {
  const g = norm(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` matches zero or more leading dirs, so `**/.env` also hits a root
        // `.env`; a bare `**` matches anything.
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i++; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$", "i");   // case-insensitive (Windows paths)
}

export function matchesAnyGlob(path, patterns) {
  if (!patterns?.length) return false;
  const p = norm(path);
  return patterns.some((g) => globToRegExp(g).test(p));
}

/**
 * Should this scanned item be excluded from the backup? `scopeRepo` is the
 * scope's native repo root (for projectFilter matching), or undefined.
 */
export function isExcludedByConfig(item, config, scopeRepo) {
  if (!config) return false;
  if (config.excludeScopes?.includes(item.scopeId)) return true;
  if (config.excludeCategories?.includes(item.category)) return true;
  if (item.path && matchesAnyGlob(item.path, config.excludePaths)) return true;

  const pf = config.projectFilter;
  if (pf?.patterns?.length && item.scopeId && item.scopeId !== "global") {
    const target = scopeRepo || item.scopeId;
    const matched = matchesAnyGlob(target, pf.patterns) || pf.patterns.includes(item.scopeId);
    if (pf.mode === "include") return !matched;   // keep only matching projects
    if (pf.mode === "exclude") return matched;    // drop matching projects
    // Unrecognized mode → no filtering applied; warn so an "include" typo (which
    // would silently back up every project) doesn't pass unnoticed.
    if (pf.mode) console.warn(`exclude.json: ignoring projectFilter — unknown mode "${pf.mode}" (use "include" or "exclude")`);
  }
  return false;
}
