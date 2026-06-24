<p align="center">
  <img src="https://raw.githubusercontent.com/seanGSISG/claude-code-backup/main/.media/image.png" alt="Claude Code Backup — back up and transport your Claude settings across Windows, WSL, Linux & macOS" width="640">
</p>

# Claude Code Backup

Automatic backup of all your Claude Code settings to GitHub. One command to set up, then it runs on boot/logon and every few hours. Works on **Linux, macOS, and Windows 11**.

## What gets backed up

Everything Claude Code stores across your machine, not just `~/.claude/`:

- **Memories** (across every scope)
- **Skills** (full directories, recursively)
- **MCP server configs** (every `.mcp.json`, `.claude.json`, settings-embedded servers)
- **Rules, Agents, Commands** (`.md` files)
- **CLAUDE.md files** (global + every project, including `.claude/CLAUDE.md`)
- **Settings** (`settings.json`, `settings.local.json`, project `.claude/` settings)
- **Plans** (`.md` files)
- **Sessions** (`.jsonl` conversation files)
- **Plugins** (cached plugin directories)

It uses the same scanner as [Claude Code Organizer](https://github.com/mcpware/claude-code-organizer) to discover items across all scopes (global + every project directory you've ever opened Claude Code in).

## Multiple environments (Windows + WSL)

Windows-native Claude Code and Claude Code running inside WSL are **separate
installs** with separate `~/.claude` stores that never merge. When you run a
backup on Windows, it automatically discovers your WSL distros (via `wsl.exe`),
reads each distro's `~/.claude` over the `\\wsl.localhost\<distro>\…` share, and
backs them up alongside the Windows store as distinct environments:

```
latest/win-DESKTOP/…          ← Windows-native store
latest/wsl-Ubuntu-DESKTOP/…   ← WSL Ubuntu store
```

Interactive runs (`init`, `run`) wake a stopped distro briefly to back it up;
scheduled background runs leave stopped distros asleep and capture WSL only when
it's already running.

## One repo, many machines

A single private repo holds **every machine you back up** — each environment
lives under its own `latest/<envId>/` folder (the `envId` embeds the hostname),
so machines never collide:

```
latest/win-DESKTOP/…            ← machine 1, Windows store
latest/wsl-Ubuntu-DESKTOP/…     ← machine 1, WSL store
latest/mac-seans-mbp/…          ← machine 2, macOS store
```

The **first machine** creates the repo; **later machines join** by cloning it,
and each `run` only rewrites its own env folders (and `git pull --rebase`es
before pushing), so machines never overwrite each other's backups.

## Quick start

```bash
npx @seangsisg/claude-code-backup init
```

This will:
1. Discover your environments (Windows-native + any WSL distros) and show what it found
2. Ask whether this is your **first machine** (creates a private repo — via the [`gh` CLI](https://cli.github.com/) if available, else asks for a URL) or **joining an existing backup** (clones the repo another machine already uses)
3. Ask your preferred backup interval (default: every 4 hours)
4. Install a scheduled job — systemd timer (Linux), LaunchAgent (macOS), or Task Scheduler task (Windows)
5. Run the first backup immediately

## Manual backup

```bash
npx @seangsisg/claude-code-backup run
```

## Check status

```bash
npx @seangsisg/claude-code-backup status
```

## Remove scheduler

```bash
npx @seangsisg/claude-code-backup uninstall
```

This only removes the scheduled task. Your backup data stays in `~/.claude-backups/`.

## How it works

```
~/.claude-backups/
├── .git/                       ← tracked by git, pushed to your private repo
├── .gitignore
├── .gitattributes              ← marks all files binary (no line-ending rewrites)
├── latest/
│   ├── win-DESKTOP/            ← one dir per environment (omitted when there's only one)
│   │   ├── env.json            ← environment identity (kind, home, osPlatform)
│   │   ├── manifest.json       ← per-item originalPath/repoRoot/isDir (drives restore)
│   │   ├── backup-summary.json
│   │   ├── global/
│   │   │   ├── memory/  skill/  mcp/  config/  rule/  plan/  agent/  command/  plugin/
│   │   │   └── …
│   │   └── C--Users-you-myproject/
│   │       ├── memory/  skill/  config/
│   │       └── session/        ← conversation history
│   ├── wsl-Ubuntu-DESKTOP/     ← WSL store, same structure
│   │   └── …
│   └── backup-summary.json     ← top-level index of all environments
├── config.json
└── backup.log
```

Every backup uses the per-environment layout (`latest/<envId>/…`), even on a
single machine, so machines can share one repo without colliding. Each `run`
rewrites only its own env folders, so git tracks just the diff — your git
history is your version history. Files are committed byte-for-byte
(`core.autocrlf=false` + `.gitattributes`), so restores match the originals
exactly on every platform.

> On Windows, `~/.claude-backups/` resolves to `%USERPROFILE%\.claude-backups`.

## Restore

```bash
git clone <your-backup-repo> ~/.claude-backups   # on the new machine
npx @seangsisg/claude-code-backup restore           # dry-run: shows exactly what would be written
npx @seangsisg/claude-code-backup restore --apply   # perform the restore
```

Restore reads each environment's `manifest.json` and maps every file back to its
real location on the current machine. It handles:

- **Same machine / new username** — rewrites the home prefix.
- **Cross-OS** — translates path separators and **re-encodes** project-dir names
  (e.g. a Linux backup's `-home-you-app` becomes `C--Users-you-app` on Windows).
- **Restoring into WSL from Windows** — writes through the `\\wsl.localhost\…` share.
- **MCP configs** — merged into the destination's host JSON (never clobbered).

Flags: `--from <envId>` / `--to <envId>` choose source/destination environments
(defaults match by OS kind); `--scope <id>` restores a single scope; `--verbose`
lists skipped items. Restore is **dry-run by default**, refuses to write outside
the destination home, never touches enterprise-managed dirs, and renames any
overwritten file to `*.bak` first.

## Scheduler details

**Linux (systemd):** User-level timer with `Persistent=true`. Runs on boot (5 min delay) and at your configured interval. Catches up missed runs if the machine was off.

**macOS (launchd):** LaunchAgent with `RunAtLoad=true`. Same behavior.

**Windows (Task Scheduler):** A task named `ClaudeCodeBackup`, registered via `schtasks`. Runs at logon (5 min delay) and repeats at your configured interval, with "start when available" so missed runs catch up — the same behavior as `Persistent`/`RunAtLoad`. It runs as the current user at the lowest privilege level, so `init` needs **no administrator elevation**. Inspect or remove it from the Task Scheduler GUI, or:

```powershell
schtasks /Query  /TN ClaudeCodeBackup /V /FO LIST   # inspect
schtasks /Run    /TN ClaudeCodeBackup               # run now
schtasks /Delete /TN ClaudeCodeBackup /F            # remove
```

## Requirements

- Node.js 18+
- Git
  - On Windows, use [Git for Windows](https://git-scm.com/download/win); its bundled OpenSSH handles SSH remotes. Long paths are handled automatically via `core.longpaths`.
- A GitHub repo. The [`gh` CLI](https://cli.github.com/) (if installed and authenticated) creates a private one for you during `init`; otherwise create one first and provide its URL (SSH or HTTPS).
- For WSL backup: WSL 2 with the `\\wsl.localhost` (or legacy `\\wsl$`) share — standard on Windows 10 2004+ / Windows 11.

## Built with

Scanner extracted from [@mcpware/claude-code-organizer](https://github.com/mcpware/claude-code-organizer).
