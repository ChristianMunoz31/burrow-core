# Installing Burrow

Burrow is a private budget and journal app that runs on your own computer. Your data stays on your computer. This guide shows how to install it and set it up.

**Note:** Burrow builds are not code-signed yet. Code signing is a planned future step. Until then you will see the security warnings described below. They are expected.

## Why you see a warning

Windows and macOS warn about apps that are not code-signed. Code signing is a paid certificate that proves who made an app. Burrow does not have one yet. The warning does not mean something is wrong with the file. It means the system cannot check who made it. Only install a Burrow file that you got from someone you trust.

## Windows

1. Download the installer for your PC. These links always give you the newest version:
   - Most PCs (Intel or AMD): [Burrow-Setup-x64.exe](https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-x64.exe)
   - ARM PCs such as Windows on Snapdragon: [Burrow-Setup-arm64.exe](https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/Burrow-Setup-arm64.exe)

   Not sure which you have? Open Settings, then System, then About, and look at "System type". All versions are on the [releases page](https://github.com/ChristianMunoz31/burrow-releases/releases).
2. Double-click the file.
3. Windows shows **Windows protected your PC** (SmartScreen), because the installer is not code-signed yet. This is expected. Click **More info**, then click **Run anyway**.
4. Follow the installer. It installs for your user only. It does not need administrator rights.
5. If your PC does not have Microsoft Edge WebView2, the installer downloads it. This needs an internet connection once.
6. Open Burrow from the Start menu.

### Check your download (optional)

Each release has a `SHA256SUMS.txt` file with the expected checksum of both installers. To check yours, open PowerShell in the folder with the installer and run:

```powershell
Get-FileHash .\Burrow-Setup-x64.exe -Algorithm SHA256
```

Use `Burrow-Setup-arm64.exe` if you downloaded the ARM installer. The hash must match the line for your file in `SHA256SUMS.txt` (download it from the same release page). If it does not match, delete the file and download it again.

## macOS

1. Download the `.dmg` file and open it.
2. Drag **Burrow** into **Applications**.
3. The first time you open it, macOS says Burrow "cannot be opened because the developer cannot be verified". To open it anyway, use either way:
   - Right-click (or Control-click) Burrow in Applications, choose **Open**, then click **Open** again.
   - Or open **System Settings > Privacy & Security**, scroll to the message about Burrow, and click **Open Anyway**.
4. You only need to do this once.

## Linux

Pick one.

- **AppImage:** make it runnable, then start it.

  ```bash
  chmod +x Burrow_x.y.z_amd64.AppImage
  ./Burrow_x.y.z_amd64.AppImage
  ```

- **.deb (Debian, Ubuntu):**

  ```bash
  sudo apt install ./Burrow_x.y.z_amd64.deb
  ```

  Then open Burrow from your app menu.

## Installing Burrow Dev next to Burrow

Burrow Dev is a test build for people helping to test new work. Most people do not need it. It installs next to Burrow, so you can keep using Burrow while you try it. It is unsigned, like all Burrow builds for now.

1. Download `Burrow-Dev_<version>_<arch>-setup.exe`. The version looks like `0.2.0-dev.20261005.abc1234`. Pick `x64` for most PCs, or `arm64` for ARM PCs.
2. Double-click the file. Windows may show **Windows protected your PC** (SmartScreen). Click **More info**, then click **Run anyway**.
3. Follow the installer. It installs for your user only, in `%LOCALAPPDATA%\Burrow Dev`, and does not need administrator rights.
4. Open **Burrow Dev** from the Start menu. It has its own icon with an amber DEV badge, and a small **Dev build** label at the top of the window.

Burrow Dev and Burrow are separate apps:

- Burrow Dev keeps its data in `%APPDATA%\Burrow Dev`. Burrow keeps its data in `%APPDATA%\Burrow`. Neither app reads or changes the other's data on its own.
- Both can run at the same time.
- Burrow Dev has its own log: `%LOCALAPPDATA%\com.burrow.desktop.dev\logs\server.log` (on macOS `~/Library/Logs/com.burrow.desktop.dev/server.log`, on Linux `~/.local/share/com.burrow.desktop.dev/logs/server.log`).
- Uninstall Burrow Dev from **Apps > Installed apps**. It is a separate entry. Uninstalling or updating it keeps `%APPDATA%\Burrow Dev` and does not touch Burrow or its data.
- Burrow Dev checks for newer Burrow Dev builds only (not for Burrow releases), and only if you turned on update checks in Settings. It never installs an update by itself: download the new Burrow Dev installer and run it.

To test with your own data, open Settings > Data & storage in Burrow Dev and use **Copy my data from Burrow**. This is one-way: Burrow Dev never changes your Burrow data, and changes you make in Burrow Dev stay in Burrow Dev. Burrow Dev makes a safety backup of its own data first, and saved keys are not copied.

## First run

1. **Your name.** Burrow asks what to call you. This is optional. You can click **Skip for now**.
2. **Set up Javi.** Javi is Burrow's built-in AI helper. It is optional. You can set it up later in Settings. Javi runs on a free app called Ollama on your computer, so nothing leaves your computer.
   - If Burrow says Ollama is missing, click **Get Ollama**. It opens https://ollama.com/download in your browser. Install Ollama and open it.
   - Come back to Burrow and click **Check again**.
   - Burrow suggests a model based on how much memory your computer has:

     | Computer memory | Suggested model | Download size |
     | --- | --- | --- |
     | Under 6 GB | `llama3.2:1b` | about 1.3 GB |
     | 6 GB to under 10 GB | `llama3.2:3b` | about 2.0 GB |
     | 10 GB to under 14.5 GB | `llama3.2:3b`, plus optional `qwen2.5:7b` | about 2.0 GB, optional 4.7 GB |
     | 14.5 GB or more | `qwen2.5:7b` for your data, plus `llama3.2:3b` for fast chat | about 4.7 GB and 2.0 GB |

   - Click **Download model**. Ollama downloads the model from the Ollama library. Burrow itself does not connect to the internet for this. A progress bar shows the download. Large models can take a while on a slow connection.
   - Click **Cancel** to stop a download. If you start it again, Ollama picks up where it left off.
   - Click **Skip for now** if you do not want Javi yet.
3. **Starter budget.** You can enter monthly amounts, or skip this step.

The first answer from Javi can be slow on a computer without a graphics card. Later answers are faster.

## Updating Burrow

Burrow never updates on its own. Update checks are off until you turn them on in Settings > Updates (or click Check now there, which turns them on). With them on, Burrow asks GitHub whether a newer version exists when you open Settings, and shows what is new. Help > Check for updates... in the desktop app opens that section.

- **Download and install.** If your copy can install updates, a card shows the new version and what is new. Nothing is downloaded until you click **Download and install**. Burrow then saves a backup of your data, the Burrow app downloads the installer from GitHub and checks its signature, and Burrow closes, installs the update and opens again. If the signature check fails, nothing is installed. Click **Later** to dismiss the card for now.
- **No update limits.** Burrow is free for everyone, so any version installs and runs fully. Nothing blocks an update.
- **Get the installer.** If your copy cannot install updates, click **Get the installer**. Burrow saves a backup of your data, shows the installer's SHA-256 and the PowerShell `Get-FileHash` command to check it against, and your browser downloads the installer. Run it over your current copy. You can also download it from the [releases page](https://github.com/ChristianMunoz31/burrow-releases/releases/latest). Your data folder is kept either way.
- Burrow Dev never installs updates itself.

## Where your data lives

| System | Folder |
| --- | --- |
| Windows | `%APPDATA%\Burrow` |
| macOS | `~/Library/Application Support/Burrow` |
| Linux | `~/.local/share/burrow` |

- The Microsoft Store edition keeps its data in the same folder, unless it was built with the user folder location (docs/MICROSOFT_STORE.md, "If Partner Center refuses unvirtualizedResources"): then it is `%USERPROFILE%\Burrow Data` (for example `C:\Users\<name>\Burrow Data`), the server log is `%USERPROFILE%\Burrow Data\logs\server.log`, and the two editions do not share data. Settings shows the exact folder at the bottom of the page. Use **Import from your existing Burrow** in Settings > Data & storage to copy the data of the website edition into it; that only copies and leaves the original untouched.
- Updating, reinstalling and uninstalling Burrow keep this folder.
- To remove your data, close Burrow and delete the folder yourself. This cannot be undone, so export your data first if you want a copy.
- To erase your data without deleting the folder, open Settings > Data & storage > Danger zone and choose **Erase all my data**. Burrow saves a final export to your Downloads folder first, erases everything (including any license or trial files an older version left), and starts over at first-run. The folder stays, so Help > Open data folder still works.

## Help menu

- **Open data folder** opens the folder above.
- **Export my data** opens Settings > Data & storage, where you can export everything as a ZIP. The file is saved to your Downloads folder and shown to you.
- **About Burrow** shows the version.

## Troubleshooting

**Burrow did not start.** The window shows an error page with the path of a log file named `server.log`. It is replaced each time Burrow starts. The folder depends on your system:

| System | Log file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\com.burrow.desktop\logs\server.log` |
| macOS | `~/Library/Logs/com.burrow.desktop/server.log` |
| Linux | `~/.local/share/com.burrow.desktop/logs/server.log` |

Close Burrow and open it again. If it still fails, share the log with the person who gave you the build. The log holds technical messages, not your budget or journal content.

**Javi says it needs Ollama.** Install Ollama from https://ollama.com/download and open it. Then click **Check again** in the Javi setup, or open Settings > AI. If Ollama is installed but not running, open the Ollama app.

**I opened Burrow a second time and nothing new appeared.** Only one Burrow runs at a time. A second launch brings the existing window to the front.

**The window says it lost its session.** Close Burrow and open it again from its app icon.
