/**
 * scheduler.mjs — Install/remove systemd timer (Linux), launchd plist (macOS),
 * or a Task Scheduler task (Windows).
 */

import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HOME = homedir();

const SERVICE_NAME = "claude-code-backup";

// ── Linux (systemd user timer) ──────────────────────────────────────

function systemdDir() {
  return join(HOME, ".config", "systemd", "user");
}

function serviceContent(nodePath, cliPath) {
  return `[Unit]
Description=Claude Code Backup — scan and push settings to GitHub

[Service]
Type=oneshot
ExecStart=${nodePath} ${cliPath} run --quiet
Environment=HOME=${HOME}
`;
}

function timerContent(intervalHours) {
  return `[Unit]
Description=Claude Code Backup Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=${intervalHours}h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

async function installSystemd(nodePath, cliPath, intervalHours) {
  const dir = systemdDir();
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, `${SERVICE_NAME}.service`),
    serviceContent(nodePath, cliPath)
  );
  await writeFile(
    join(dir, `${SERVICE_NAME}.timer`),
    timerContent(intervalHours)
  );

  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.timer`]);

  return {
    servicePath: join(dir, `${SERVICE_NAME}.service`),
    timerPath: join(dir, `${SERVICE_NAME}.timer`),
  };
}

async function removeSystemd() {
  try {
    await exec("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.timer`]);
  } catch {}
  const dir = systemdDir();
  try { await unlink(join(dir, `${SERVICE_NAME}.service`)); } catch {}
  try { await unlink(join(dir, `${SERVICE_NAME}.timer`)); } catch {}
  try { await exec("systemctl", ["--user", "daemon-reload"]); } catch {}
}

async function statusSystemd() {
  try {
    const { stdout } = await exec("systemctl", [
      "--user", "status", `${SERVICE_NAME}.timer`, "--no-pager",
    ]);
    return stdout;
  } catch (err) {
    return err.stdout || err.stderr || "Timer not installed";
  }
}

// ── macOS (launchd plist) ───────────────────────────────────────────

function launchdDir() {
  return join(HOME, "Library", "LaunchAgents");
}

function plistLabel() {
  return `com.seangsisg.${SERVICE_NAME}`;
}

function plistContent(nodePath, cliPath, intervalSeconds) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>run</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.claude-backups/backup.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.claude-backups/backup.log</string>
</dict>
</plist>
`;
}

async function installLaunchd(nodePath, cliPath, intervalHours) {
  const dir = launchdDir();
  await mkdir(dir, { recursive: true });
  const plistPath = join(dir, `${plistLabel()}.plist`);
  await writeFile(plistPath, plistContent(nodePath, cliPath, intervalHours * 3600));

  try {
    await exec("launchctl", ["unload", plistPath]);
  } catch {}
  await exec("launchctl", ["load", plistPath]);

  return { plistPath };
}

async function removeLaunchd() {
  const plistPath = join(launchdDir(), `${plistLabel()}.plist`);
  try { await exec("launchctl", ["unload", plistPath]); } catch {}
  try { await unlink(plistPath); } catch {}
}

async function statusLaunchd() {
  try {
    const { stdout } = await exec("launchctl", ["list", plistLabel()]);
    return stdout;
  } catch {
    return "LaunchAgent not installed";
  }
}

// ── Windows (Task Scheduler) ────────────────────────────────────────

const TASK_NAME = "ClaudeCodeBackup";

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Task Scheduler XML mirroring the systemd/launchd behavior:
//   - LogonTrigger + 5min delay  ≈ OnBootSec=5min / RunAtLoad
//   - Repetition every N hours    ≈ OnUnitActiveSec / StartInterval
//   - StartWhenAvailable=true     ≈ Persistent=true (catch up missed runs)
// Runs at LeastPrivilege as the current user, so `init` needs no elevation.
// The <UserId> inside the LogonTrigger scopes it to the current user — a
// logon trigger without a UserId means "any user" and requires admin to create.
// Note: Task Scheduler has no stdout redirection, so the launchd backup.log
// is not reproduced here — `run --quiet` suppresses output anyway.
function currentUser() {
  return process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME || "";
}

function taskXmlContent(nodePath, cliPath, intervalHours) {
  const user = xmlEscape(currentUser());
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Claude Code Backup — scan and push settings to GitHub</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT5M</Delay>
      <UserId>${user}</UserId>
      <Repetition>
        <Interval>PT${intervalHours}H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>"${xmlEscape(cliPath)}" run --quiet</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

async function installWindows(nodePath, cliPath, intervalHours) {
  const xmlPath = join(tmpdir(), `${TASK_NAME}-${process.pid}.xml`);
  // schtasks /XML is reliable with UTF-16LE + BOM; UTF-8 fails on some builds.
  await writeFile(xmlPath, "﻿" + taskXmlContent(nodePath, cliPath, intervalHours), "utf16le");
  try {
    await exec("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  } finally {
    try { await unlink(xmlPath); } catch {}
  }
  return { taskName: TASK_NAME };
}

async function removeWindows() {
  try {
    await exec("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
  } catch {}
}

async function statusWindows() {
  try {
    const { stdout } = await exec("schtasks", ["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]);
    return stdout;
  } catch {
    return "Scheduled task not installed";
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Install scheduled backup.
 * @param {string} nodePath - Full path to node binary
 * @param {string} cliPath - Full path to cli.mjs
 * @param {number} intervalHours - Backup interval in hours (default: 4)
 */
export async function install(nodePath, cliPath, intervalHours = 4) {
  if (platform() === "win32") {
    return installWindows(nodePath, cliPath, intervalHours);
  }
  if (platform() === "darwin") {
    return installLaunchd(nodePath, cliPath, intervalHours);
  }
  return installSystemd(nodePath, cliPath, intervalHours);
}

/**
 * Remove scheduled backup.
 */
export async function remove() {
  if (platform() === "win32") {
    return removeWindows();
  }
  if (platform() === "darwin") {
    return removeLaunchd();
  }
  return removeSystemd();
}

/**
 * Get scheduler status.
 */
export async function status() {
  if (platform() === "win32") {
    return statusWindows();
  }
  if (platform() === "darwin") {
    return statusLaunchd();
  }
  return statusSystemd();
}
