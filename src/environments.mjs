/**
 * environments.mjs — Discover every Claude Code "environment" reachable from
 * the current process.
 *
 * An environment is one independent `~/.claude` store. On a plain Linux/macOS
 * box that's just the local one. On Windows it's the native store PLUS every
 * WSL distro's store (reached over the `\\wsl.localhost\<distro>\…` 9p share),
 * because Windows-native Claude Code and WSL Claude Code are completely
 * separate installs that never merge and can drift.
 *
 * Discovery is read-only: it reads (env vars, /proc, `wsl.exe`, UNC stat) but
 * never scans content. Its only possible side effect is that probing a stopped
 * WSL distro can auto-start it — gated behind `startStopped`. The one exception
 * is persistedMachineIdentity(), which writes <backupDir>/machine-id.json once
 * to mint this machine's stable UUID identity.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform, hostname } from "node:os";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);

/**
 * @typedef {Object} Environment
 * @property {string}  id          "<osKind>[-<distro>]-<machineId>"
 * @property {"win"|"wsl"|"linux"|"mac"} kind
 * @property {string} [distro]     WSL distro name (kind === "wsl" only)
 * @property {string}  home        store's HOME as the store sees it ("/home/u" | "C:\\Users\\u")
 * @property {string}  claudeDir   path the CURRENT process uses to READ this store's .claude
 * @property {string}  managedDir  managed-config dir reachable by current process
 * @property {"fs"|"unc"} accessVia "fs" = direct OS fs; "unc" = Windows UNC into WSL 9p
 * @property {"win32"|"linux"|"darwin"} osPlatform  the STORE's OS (WSL = "linux")
 * @property {string} [uncRoot]    "\\wsl.localhost\<distro>" | "\\wsl$\<distro>" (unc only)
 * @property {"posix"|"win"} pathStyle  how this store encodes project-dir names
 * @property {string} [note]       degradation / uncertainty marker
 */

const DOCKER_NOISE = new Set([
  "docker-desktop", "docker-desktop-data",
  "rancher-desktop", "rancher-desktop-data",
]);

/** Sanitize a hostname into a stable, filesystem-safe machine id. */
export function machineId() {
  return (hostname() || "machine")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "machine";
}

/** First 8 hex of a UUID — the short, stable, machine-unique envId suffix. */
export function uuid8(uuid) {
  return String(uuid || "").replace(/-/g, "").slice(0, 8);
}

/**
 * Read (or, on first run, create) this machine's persisted identity. This is
 * the ONE write in this otherwise read-only module — it lives at
 * `<backupDir>/machine-id.json` and is the source of truth for envId.
 *
 * A hostname is NOT unique (two machines named DESKTOP collide), so identity is
 * a random UUID generated once and never regenerated. The first 8 hex of that
 * UUID become the envId suffix, so different machines can never share an env dir
 * and clobber each other's backup.
 *
 * @param {string} backupDir  the backup repo root (~/.claude-backups)
 * @param {{ label?: string, role?: "work"|"home"|"shared" }} [opts]
 *   label/role are used only when the file is first created (init supplies them);
 *   defaults are the hostname and "shared" so unattended runs still work.
 * @returns {Promise<{uuid,label,role,hostname,createdAt}>}
 */
export async function persistedMachineIdentity(backupDir, opts = {}) {
  const file = join(backupDir, "machine-id.json");
  try {
    const existing = JSON.parse(await readFile(file, "utf-8"));
    if (existing && existing.uuid) return existing;   // never auto-regenerate
  } catch { /* missing or malformed — (re)create below */ }

  const host = hostname() || "machine";
  const identity = {
    uuid: randomUUID(),
    label: opts.label || host,
    role: opts.role || "shared",
    hostname: host,
    createdAt: new Date().toISOString(),
  };
  await mkdir(backupDir, { recursive: true });
  // Exclusive create: if two first-runs race, only one UUID can win. The loser
  // adopts the winner's file rather than continuing with an orphaned in-memory id.
  try {
    await writeFile(file, JSON.stringify(identity, null, 2) + "\n", { flag: "wx" });
    return identity;
  } catch (err) {
    if (err?.code === "EEXIST") {
      const winner = JSON.parse(await readFile(file, "utf-8"));
      if (winner?.uuid) return winner;
    }
    throw err;
  }
}

/** Is THIS process running inside a WSL distro? */
async function isInsideWSL() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  // Covers systemd-managed WSL where the interop env vars are not exported.
  for (const f of ["/proc/sys/kernel/osrelease", "/proc/version"]) {
    try {
      const t = (await readFile(f, "utf-8")).toLowerCase();
      if (t.includes("microsoft") || t.includes("wsl")) return true;
    } catch {}
  }
  return false;
}

/**
 * Build the single environment record for the current process, WITHOUT probing
 * for sibling WSL distros. Synchronous and side-effect-free — used as the
 * default ctx for scan() so the common single-store path stays cheap.
 *
 * Note: the inside-WSL `kind` here relies on env vars only (sync). The full
 * discoverEnvironments() does the thorough /proc check. Mislabeling kind has no
 * effect on paths — claudeDir is still homedir/.claude with accessVia "fs".
 */
export function nativeEnvironment(opts = {}) {
  const mid = opts.machineId || machineId();
  const home = homedir();
  const p = platform();

  if (p === "win32") {
    return {
      id: `win-${mid}`, kind: "win", home,
      claudeDir: join(home, ".claude"),
      managedDir: join(process.env.ProgramData || "C:\\ProgramData", "ClaudeCode"),
      accessVia: "fs", osPlatform: "win32", pathStyle: "win",
    };
  }
  if (p === "darwin") {
    return {
      id: `mac-${mid}`, kind: "mac", home,
      claudeDir: join(home, ".claude"),
      managedDir: "/Library/Application Support/ClaudeCode",
      accessVia: "fs", osPlatform: "darwin", pathStyle: "posix",
    };
  }
  // linux — possibly inside WSL
  const distro = process.env.WSL_DISTRO_NAME;
  if (distro) {
    return {
      id: `wsl-${distro}-${mid}`, kind: "wsl", distro, home,
      claudeDir: join(home, ".claude"),
      managedDir: "/etc/claude-code",
      accessVia: "fs", osPlatform: "linux", pathStyle: "posix",
    };
  }
  return {
    id: `linux-${mid}`, kind: "linux", home,
    claudeDir: join(home, ".claude"),
    managedDir: "/etc/claude-code",
    accessVia: "fs", osPlatform: "linux", pathStyle: "posix",
  };
}

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Decode UTF-16LE `wsl.exe` output → array of distro names. */
function decodeWslList(buf) {
  return new TextDecoder("utf-16le").decode(buf)
    .replace(/^﻿/, "")                 // strip BOM
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, "").trim())
    .filter(Boolean);
}

function isRealDistro(n) {
  const lower = n.toLowerCase();
  if (DOCKER_NOISE.has(lower)) return false;
  if (n.includes(":") || n.includes("(")) return false;  // localized header line
  return true;
}

/** List ALL installed WSL distro names (Windows host only). Returns [] on any failure. */
async function listWslDistros() {
  let stdout;
  try {
    ({ stdout } = await exec("wsl.exe", ["-l", "-q"],
      { encoding: "buffer", timeout: 5000, windowsHide: true }));
  } catch {
    return [];   // no WSL feature, no distros, or wsl.exe missing
  }
  return decodeWslList(stdout).filter(isRealDistro);
}

/**
 * Set of currently-RUNNING distro names, parsed from `wsl -l -v`'s STATE column.
 * `wsl -l --running -q` proved unreliable via execFile; `-l -v` is robust.
 * Best-effort: returns an empty set if the listing can't be parsed.
 */
async function runningDistros() {
  let stdout;
  try {
    ({ stdout } = await exec("wsl.exe", ["-l", "-v"],
      { encoding: "buffer", timeout: 5000, windowsHide: true }));
  } catch {
    return new Set();
  }
  const set = new Set();
  const lines = new TextDecoder("utf-16le").decode(stdout).replace(/^﻿/, "").split(/\r?\n/);
  for (const raw of lines.slice(1)) {                 // skip header row
    const cols = raw.replace(/\0/g, "").replace(/^\*?\s*/, "").trim().split(/\s+/);
    if (cols.length >= 2 && isRealDistro(cols[0]) && cols[1].toLowerCase() === "running") {
      set.add(cols[0]);
    }
  }
  return set;
}

/** Build a UNC path by string concat (never path.join on a bare UNC root). */
function toUnc(prefix, distro, posixPath) {
  return `\\\\${prefix}\\${distro}` + posixPath.replace(/\//g, "\\");
}

/** Resolve one WSL distro's environment record, or null if unreachable / no Claude install. */
async function resolveWslEnv(distro, mid) {
  let home;
  try {
    // printenv (not `printf "$HOME"`) — avoids shell-expansion ambiguity across shells.
    const { stdout } = await exec("wsl.exe", ["-d", distro, "--", "printenv", "HOME"],
      { encoding: "buffer", timeout: 15000, windowsHide: true });  // generous: cold start
    home = new TextDecoder("utf-8").decode(stdout).trim();
    if (!home || !home.startsWith("/")) {
      // fallback for shells where printenv is absent
      const r = await exec("wsl.exe", ["-d", distro, "--", "sh", "-c", 'printf %s "$HOME"'],
        { encoding: "buffer", timeout: 15000, windowsHide: true });
      home = new TextDecoder("utf-8").decode(r.stdout).trim();
    }
    if (!home || !home.startsWith("/")) return null;
  } catch {
    return null;
  }

  // Prefer modern \\wsl.localhost, fall back to legacy \\wsl$.
  for (const prefix of ["wsl.localhost", "wsl$"]) {
    const claudeDir = toUnc(prefix, distro, home + "/.claude");
    if (await pathExists(claudeDir)) {
      return {
        id: `wsl-${distro}-${mid}`, kind: "wsl", distro, home,
        claudeDir,
        managedDir: toUnc(prefix, distro, "/etc/claude-code"),
        accessVia: "unc", osPlatform: "linux", pathStyle: "posix",
        uncRoot: `\\\\${prefix}\\${distro}`,
        note: "WSL via UNC(9p): slower; managed dir may be root-owned/unreadable",
      };
    }
  }
  return null;   // no Claude Code installed in this distro
}

let _cache = null;

/**
 * Discover all reachable Claude Code environments.
 * Always returns at least the current native environment; degrades to fewer
 * environments (never throws) when WSL discovery fails.
 *
 * @param {{ startStopped?: boolean, machineId?: string }} [opts]
 *   startStopped — probe stopped WSL distros too (auto-starts them). Default false.
 */
export async function discoverEnvironments(opts = {}) {
  if (_cache && !opts.machineId) return _cache;
  const mid = opts.machineId || machineId();
  const envs = [nativeEnvironment({ machineId: mid })];

  // WSL-crossing is gated strictly to a Windows host. A process inside WSL,
  // or on native Linux/macOS, reports only itself.
  if (platform() === "win32") {
    const all = await listWslDistros();
    // Stopped distros are probed (and thereby auto-started) only when allowed —
    // scheduled/unattended runs leave them asleep; interactive runs wake them.
    const running = opts.startStopped ? null : await runningDistros();
    const targets = opts.startStopped ? all : all.filter((d) => running.has(d));
    const resolved = await Promise.allSettled(targets.map((d) => resolveWslEnv(d, mid)));
    for (const r of resolved) {
      if (r.status === "fulfilled" && r.value) envs.push(r.value);
    }
  }

  if (!opts.machineId) _cache = envs;
  return envs;
}
