# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-06-23

### Added
- The `/backup` skill (`skills/`) and `CHANGELOG.md` are now included in the
  published npm package so a global install ships them too.
- README banner image.

## [0.3.0] - 2026-06-23

### Added
- **Multi-environment backup (Windows + WSL).** A backup run on Windows now
  discovers your WSL distros via `wsl.exe`, reads each distro's `~/.claude` over
  the `\\wsl.localhost\<distro>\…` share, and backs them up alongside the
  Windows-native store as distinct environments under `latest/<envId>/`. The new
  `src/environments.mjs` module performs the discovery; the scanner was made
  environment-aware (`scan(ctx)`), so a single run can capture multiple stores.
  Interactive runs wake a stopped distro to back it up; scheduled (`--quiet`)
  runs leave stopped distros asleep.
- **`restore` command.** `claude-code-backup restore` reads each environment's
  `manifest.json` and maps every file back to its real location on the current
  machine — including cross-OS restores (path-separator translation + project
  directory re-encoding) and restoring into a WSL distro from Windows over UNC.
  Dry-run by default (`--apply` to write); `--from`/`--to`/`--scope`/`--verbose`
  flags; refuses to write outside the destination home, skips managed dirs, and
  writes a `*.bak` before overwriting. MCP server configs are merged into the
  destination's host JSON rather than clobbering it.
- **Automatic GitHub repo creation in `init`.** When the [`gh` CLI](https://cli.github.com/)
  is installed and authenticated, `init` offers to create a private repo
  (`claude-backup-<hostname>`) over HTTPS instead of requiring a pre-created repo
  and SSH key. Falls back to the manual URL prompt otherwise.
- A per-environment `manifest.json` and `env.json` are written with each backup
  to record item origins and environment identity (required by `restore`).
- **Public-remote guard.** Backups go to a private repo by default; the tool now
  refuses to push when the backup remote is a PUBLIC GitHub repo (verified via
  the `gh` CLI), since `~/.claude` can hold secrets. Override with `--allow-public`.
  `init` also warns immediately if a manually-entered remote is public.

### Fixed
- The scanner's MCP-policy reader hardcoded `/etc/claude-code/managed-settings.json`;
  it now uses the environment's platform-aware managed directory (a Windows bug).
- Project-scope depth sorting split paths on `/` only, mis-ordering Windows/UNC
  backslash paths; it now splits on both separators.
- **Large backups failed to commit** with "stdout maxBuffer length exceeded": a
  big initial commit lists thousands of files and overflowed `execFile`'s default
  1 MB buffer. Git now runs with a 64 MB buffer and a longer timeout.

## [0.2.0] - 2026-06-23

### Added
- **Native Windows 11 support.** `init`, `run`, `status`, and `uninstall` now
  work on Windows. The scheduler registers a Task Scheduler task named
  `ClaudeCodeBackup` via `schtasks /Create /XML`, with a logon trigger (5-min
  delay) plus an N-hour repetition and "start when available", mirroring the
  systemd timer and launchd LaunchAgent. It runs as the current user at the
  lowest privilege level, so setup needs no administrator elevation.
- Windows-aware managed config directory in the scanner
  (`%ProgramData%\ClaudeCode`).
- A `.gitattributes` file (`* -text`) is written at init so every backed-up
  file is treated as binary and never has its line endings rewritten.

### Fixed
- **Backups failed to commit on Windows with "Filename too long".** Git for
  Windows enforces the 260-character `MAX_PATH` limit, which deeply-nested
  plugin skill paths exceed. Git now runs with `core.longpaths=true` so those
  paths are handled (no-op on Linux/macOS).
- **Project-scope config files were silently dropped from every backup** on all
  platforms. Items such as `.claude/settings.json` use a nested file name, but
  the exporter only created the category directory, so the copy failed with
  `ENOENT`. The destination's parent directory is now created before copying.
- **Scheduler installation produced a broken path on Windows.** The CLI derived
  its own path with `new URL(import.meta.url).pathname`, which yields a
  malformed `/C:/...` path on Windows; it now uses `fileURLToPath`.
- Backups are committed byte-for-byte (`core.autocrlf=false`), so restores match
  the originals exactly and diffs no longer churn on line endings.

## [0.1.0] - 2026-04-07

### Added
- Initial release: scan, export, git sync, and scheduling (systemd on Linux,
  launchd on macOS).
- `/backup` skill for running backups from within Claude Code.
- Git SSH environment passthrough (`GIT_SSH_COMMAND`) for custom SSH keys.
