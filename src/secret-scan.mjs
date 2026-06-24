/**
 * secret-scan.mjs — Heuristic scan of exported backup files for likely secrets.
 *
 * The whole point of this tool is a COMPLETE, restorable backup, so it
 * intentionally keeps secrets (MCP keys, settings.local.json, sessions). That's
 * exactly why the repo must stay private. This scan doesn't drop anything — it
 * just surfaces a one-line warning per run so the user is reminded to keep the
 * remote private and rotate anything that may have leaked. Non-blocking by design.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";

// Broad heuristic — favors recall (a reminder) over precision; non-blocking.
const SECRET_RE = /(bearer|api[_-]?key|secret|token|password|sk-[a-z0-9]{16,})/i;
const MAX_BYTES = 1024 * 1024;        // skip files larger than 1 MB
// Config carriers where a hit is ACTIONABLE (rotate that key). Session `.jsonl`
// is deliberately excluded: prose full of "token"/"secret" would fire every run
// and train the user to ignore the warning — and sessions are already covered by
// the private-repo guarantee.
const TEXT_EXT = new Set([".json", ".md", ".txt", ".sh", ".toml", ".yaml", ".yml", ".env", ""]);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * Scan one or more directories (recursively) for text files whose contents match
 * the secret heuristic. Returns { hits: string[] (file paths), filesScanned }.
 */
export async function scanForSecrets(dirs, opts = {}) {
  const re = opts.pattern || SECRET_RE;
  const hits = [];
  let filesScanned = 0;
  const roots = Array.isArray(dirs) ? dirs : [dirs];

  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      // Don't follow symlinked dirs — a circular link would recurse forever.
      if (e.isDirectory()) { if (!e.isSymbolicLink()) await walk(p); continue; }
      if (!e.isFile()) continue;
      if (!TEXT_EXT.has(extOf(e.name))) continue;
      let st; try { st = await stat(p); } catch { continue; }
      if (st.size > MAX_BYTES) continue;
      let text; try { text = await readFile(p, "utf-8"); } catch { continue; }
      filesScanned++;
      re.lastIndex = 0;                 // safe even if a caller passes a /g/ regex
      if (re.test(text)) hits.push(p);
    }
  }

  for (const r of roots) await walk(r);
  return { hits, filesScanned };
}

/** One-line, non-blocking warning for a run, or "" when nothing matched. */
export function secretWarning(hits) {
  if (!hits.length) return "";
  const sample = hits.slice(0, 3).map((p) => basename(p)).join(", ");
  const more = hits.length > 3 ? `, +${hits.length - 3} more` : "";
  return `⚠ ${hits.length} backed-up file(s) may contain secrets (${sample}${more}). ` +
    `Keep the backup repo PRIVATE; rotate any exposed MCP keys/tokens.`;
}
