# Installing jobauto

jobauto runs on your own computer: one password, your data in a PostgreSQL database on that machine, and an AI model you choose. This page is the one place for installing, starting, updating and fixing it.

| Way | For whom | Status |
|---|---|---|
| [1. Clone with Git](#1-clone-with-git) | You can use a terminal. Windows, macOS or Linux. | Available |
| [2. Download a zip](#2-download-a-zip-windows) | Windows, no terminal: download, double-click, done. Works on an empty computer. | Available |
| [3. Docker](#3-docker) | You have Docker Desktop, or a server. | As in upstream Dossier |

The Apply tab opens the employer's form in a browser window on the machine the app runs on, so install it on the computer you apply from. If it runs on a server instead, see [Apply from a laptop](#apply-from-a-laptop).

## What you need

- Windows 10 or 11. macOS and Linux work with section 1 too, but are less tested.
- About 2 GB of free memory and 3 GB of free disk, and an internet connection for the install.
- Microsoft Edge or Google Chrome. The app prints PDFs and fills in application forms with one of them. Edge comes with Windows.
- Later, in the app: an API key for an AI provider (Groq is free, DeepSeek, Gemini and Anthropic are pay per use), or a local model through Ollama or LM Studio.

## 1. Clone with Git

### Windows

These steps set the app up on a Windows 10 or 11 laptop, without Docker. The first time takes about 30 minutes. After that, starting it is a double-click.

Type the commands in **PowerShell**: open the Start menu, type `PowerShell` and open **Windows PowerShell**. Run one line at a time, and wait until it has finished before the next. Yellow warnings are normal.

#### 1. Install the tools (once)

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id PostgreSQL.PostgreSQL.18 --interactive
```

- If winget asks you to agree to its source terms, type `Y` and press Enter.
- When Windows asks **Do you want to allow this app to make changes to your device?**, click **Yes**.
- The PostgreSQL installer opens its own window. Click **Next** through it. When it asks for a **password for the database superuser**, choose one with only letters and numbers, and write it down: step 3 needs it. Keep the port **5432**. At the end, untick **Stack Builder** and click **Finish**.

Then **close PowerShell and open it again**, so that it finds the new tools, and run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
npm install -g corepack
corepack enable
```

The first line lets PowerShell run the `npm` and `yarn` commands: if it asks, type `Y` and press Enter. The other two install Yarn, which this project uses instead of npm.

#### 2. Get the app (once)

```powershell
cd $HOME
git clone https://github.com/vishnucta/jobauto.git
cd jobauto
yarn install
```

This puts the app in a folder called `jobauto` in your user folder. If it asks whether Corepack may download Yarn, type `Y` and press Enter. `yarn install` downloads everything the app needs, which takes a few minutes. That includes a ready-made copy of `better-sqlite3`, the driver for an SQLite file, which the app can keep its data in instead of PostgreSQL; if there's no ready-made copy for your version of Node.js, it tries to build one, which needs Visual Studio's C++ build tools.

#### 3. Make your settings file (once)

The app reads its password and secrets from a file called `.env` in the `jobauto` folder. It stays on your laptop and never goes to GitHub.

```powershell
Copy-Item .env.example .env
yarn hash-password
```

Type the password you want to sign in to the app with, then the same again. You won't see it while you type. It prints one long line that starts with `argon2id:`. Select that line with the mouse, press **Ctrl+C**, and open the file:

```powershell
notepad .env
```

Paste the line right after `DOSSIER_PASSWORD=`, so that it reads `DOSSIER_PASSWORD=argon2id:…`. Leave Notepad open, and in PowerShell make a random secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy what it prints and paste it right after `DOSSIER_SECRET=`. Last, in the `DATABASE_URL` line, put your database password from step 1 in place of the second `postgres`:

```
DATABASE_URL="postgresql://postgres:YOUR-DATABASE-PASSWORD@localhost:5432/dossier"
```

Save the file and close Notepad. Keep `.env` private, and don't lose it: it holds your sign-in, and `DOSSIER_SECRET` unlocks the API keys the app saves.

#### 4. Set up the database (once)

```powershell
yarn generate
yarn prisma migrate deploy
yarn prisma db seed
```

The first command prepares the app's database code, for PostgreSQL and SQLite alike. The second creates the database the first time. Ignore any message that suggests updating Prisma.

#### 5. Start it

```powershell
cd $HOME\jobauto
yarn dev
```

Open **http://localhost:3000** in your browser and sign in with your password. Leave the PowerShell window open while you use the app. The first pages take a little while to load. To stop the app, press **Ctrl+C** in that window, or close it.

If Windows asks whether Node.js may use the network, click **Cancel** and the app opens only on this laptop. Allow it on **Private networks** only if you want to open the app from your phone on your home Wi-Fi.

To start it with a double-click from now on, run this once. It puts **Jobauto** on your desktop:

```powershell
Set-Content "$([Environment]::GetFolderPath('Desktop'))\Jobauto.cmd" "@echo off`r`ncd /d `"$HOME\jobauto`"`r`nstart `"`" http://localhost:3000`r`nyarn dev"
```

The browser opens before the app is ready: if it can't connect, wait a few seconds and refresh.

Continue with [First steps in the app](#first-steps-in-the-app).

### macOS and Linux

The same steps, with the tools from your package manager. Less tested than Windows; upstream Dossier recommends [Docker](#3-docker) here.

1. Install Git, Node.js 24 or newer, and PostgreSQL 18. On macOS with Homebrew: `brew install git node postgresql@18`, then `brew services start postgresql@18`. On Debian or Ubuntu, take PostgreSQL 18 from [postgresql.org's repository](https://www.postgresql.org/download/linux/), since the distribution's own package is older, and give the `postgres` user a password: `sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'choose-one'"`.
2. `npm install -g corepack && corepack enable`, then clone and install as in Windows step 2.
3. Settings file as in Windows step 3, with `openssl rand -base64 32` for the secret. With Homebrew's PostgreSQL, the superuser is your own macOS user without a password: `DATABASE_URL="postgresql://YOUR-USERNAME@localhost:5432/dossier"`.
4. Database as in Windows step 4.
5. `yarn dev`, then open http://localhost:3000.

PDFs need a browser: install Google Chrome, or run `yarn playwright install chromium` once (on Linux, `yarn playwright install --with-deps chromium`).

## 2. Download a zip (Windows)

For a Windows 10 or 11 computer with nothing on it: no Git, no Node.js, no PostgreSQL. The installer puts them there. You need an internet connection, about 3 GB of free disk, and to be allowed to say **Yes** when Windows asks whether a program may make changes to the device.

### Install

1. Download `jobauto-windows-<version>.zip` from the [Releases page](https://github.com/vishnucta/jobauto/releases).
2. Right-click the zip and choose **Extract All**. Open the extracted folder, not the zip itself.
3. Double-click **Install.cmd**. If SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**. When Windows asks whether to allow changes, click **Yes**: a second window installs Node.js and PostgreSQL and closes by itself.
4. Type the password you want to sign in with, twice. You won't see it while you type. Nothing else is asked.
5. Wait, 10 to 15 minutes on a normal laptop and connection. The window counts seven steps; the long one is "Yarn and the app's packages".
6. At the end it asks **Start Jobauto now?** Press Enter. The browser opens at **http://localhost:3000** once the app answers. Sign in with your password.
7. Continue with [First steps in the app](#first-steps-in-the-app).

What the installer does, in its seven steps: checks the computer; installs Node.js and PostgreSQL 18 (with winget, or straight from nodejs.org and EDB when winget is missing); copies the app to `%LOCALAPPDATA%\Jobauto\app`; installs Yarn through Corepack and the app's packages; writes the settings file `app\.env` with a hash of your password, a random secret and the database address (a generated database password, never shown); creates the database; puts **Jobauto** on the Desktop and in the Start menu. Everything stays on this computer. The log is `install.log` in that folder.

### Daily use

Double-click **Jobauto** on the Desktop or in the Start menu. A black window stays open while you use the app; the browser opens by itself when the app is ready. Close the window to stop the app.

### Updating

Close the Jobauto window. Then open `%LOCALAPPDATA%\Jobauto` (paste that into the address bar of a File Explorer window) and double-click **Update.cmd**. It fetches the latest release, installs it over the old version, and keeps your settings file and your database. Downloading a newer zip and running its `Install.cmd` again does the same.

### Removing

Close the Jobauto window, open `%LOCALAPPDATA%\Jobauto` and double-click **Uninstall.cmd**. It removes the app and the shortcuts, and asks before deleting the database. To keep a copy of your data first, start the app and use **Settings → Your data → Export everything**. Node.js and PostgreSQL stay installed, since other software may use them; **Settings → Apps** removes them.

### If PostgreSQL is already on the computer

The installer uses it instead of installing another one. It asks for the password of PostgreSQL's `postgres` user, the one chosen when PostgreSQL was installed, and checks it before going on.

### For maintainers: building and publishing the zip

The zip is `git archive` of a commit (tracked files only, so never a `.env`, `node_modules` or personal data) plus `Install.cmd`, `README-Windows.txt` and a `VERSION` file. Build it from a clone with Git and PowerShell:

```powershell
cd jobauto
powershell -ExecutionPolicy Bypass -File installer\make-bundle.ps1 -Version 2026.11.0
```

That writes `dist\jobauto-windows-2026.11.0.zip`, about 12 MB. Publish it as a release whose tag is the version with a `jobauto-` prefix, which `Update.cmd` compares with the installed `VERSION`:

```powershell
git tag -a jobauto-2026.11.0 -m "Windows zip 2026.11.0"
git push origin main --tags
gh repo set-default vishnucta/jobauto
gh release create jobauto-2026.11.0 dist\jobauto-windows-2026.11.0.zip --title "jobauto 2026.11.0" --notes "What changed."
```

The `set-default` line is needed once per clone: with an `upstream` remote present, gh would otherwise address upstream Dossier.

Before publishing, test the zip on a clean Windows: **Windows Sandbox** (turn it on under *Turn Windows features on or off*, then drag the zip into it) or a fresh virtual machine. Run `Install.cmd`, start the app and sign in, run `Install.cmd` again to see it update, then `Uninstall.cmd`. For scripted tests the installer takes `-NonInteractive -Password … -DatabaseUrl … -SkipTools -NoShortcuts -NoStart`, and `uninstall.ps1` takes `-Yes` and `-DropDatabase`.

## 3. Docker

Docker Desktop on macOS or Windows, or Docker Engine on Linux: follow **Run it on your computer** in the [README](README.md#run-it-on-your-computer), and upstream's [installation guide](https://github.com/AienTech/dossier/wiki) for servers. The image there is upstream Dossier's: the fork's additions (Groq, DeepSeek and Gemini, the Apply tab, the Edge and Chrome fallbacks) need the fork's source, so build it yourself with `docker compose build` from a clone instead of pulling the image. The Apply tab needs a screen, which a container doesn't have: prefer section 1 on the computer you apply from, or let it use the Chrome on your laptop, as in the next section.

## Apply from a laptop

When the app runs on a server, such as a NAS, and you open it from a laptop, the server has no screen to show the Apply tab's browser window on. Instead, it can use a Chrome on your laptop: you start that Chrome from a shortcut that opens its remote debugging port, and the server reaches it through [Tailscale](https://tailscale.com). The window then opens on your laptop as it would locally, and the server fills it in. These steps are for a Windows laptop with Google Chrome, already signed in to the same Tailscale network as the server.

1. **Find the laptop's Tailscale address.** Click the Tailscale icon by the clock: the address starts with `100.`, such as `100.101.102.103`. Or type `tailscale ip -4` in PowerShell.
2. **Make the shortcut.** Right-click the desktop, choose **New → Shortcut**, and paste this as the location:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\jobauto-apply-chrome"
   ```
   Call it **Chrome for Apply**. It opens a Chrome with a profile of its own, apart from your everyday Chrome: Chrome only opens the debugging port for a separate profile.
3. **Let the server reach it (once).** Chrome only listens on the laptop itself. This passes its port on to your Tailscale network, not to the internet. In PowerShell (as administrator, if it says access is denied):
   ```powershell
   tailscale serve --bg --tcp 9222 tcp://127.0.0.1:9222
   ```
   To undo it later: `tailscale serve reset`.
4. **Tell the app.** Start **Chrome for Apply**. In the app, open an application's **Apply** tab, enter `http://` followed by the laptop's address and `:9222` under **Browser window**, such as `http://100.101.102.103:9222`, then click **Test** and **Save**. Use the address, not the laptop's name: Chrome doesn't answer names.

From then on, start **Chrome for Apply** before you click **Open and fill it in**. Sign in to job sites in that window: it remembers you. If it isn't open, the Apply tab says so and nothing happens.

While **Chrome for Apply** is open, any device in your Tailscale network can control it, which is how the server fills in forms. Use it only for applying, and close it when you're done. To let only the server reach it, add a rule in Tailscale's access controls that allows port 9222 on the laptop only from the server.

The address under **Browser window** is how the server reaches your laptop, not how you reach the app. Opening the app at its home network address, such as `http://192.168.0.246:3000`, doesn't change it.

### If the Apply tab says Chrome didn't answer

Check these on the laptop, in order:

1. **Is Chrome open for debugging?** Start **Chrome for Apply**, then open `http://127.0.0.1:9222/json/version` in it. If that page shows nothing, close every Chrome window and start the shortcut again.
2. **Did step 3 run?** Run the `tailscale serve` line again; it does no harm.
3. **Is the server on Tailscale too?** It can only reach a `100.` address if it is. If it isn't, use your home network instead, as below.

### Without Tailscale: on your home network

When the laptop and the server are on the same home network, the server can reach the laptop by its home network address instead. Chrome still only listens on the laptop itself, so Windows passes the port on. Make the shortcut as in step 2, then:

1. **Find the laptop's home network address.** Type `ipconfig` in PowerShell: it's the **IPv4 Address** under your Wi-Fi or Ethernet adapter, such as `192.168.0.57`. Reserve that address for the laptop in your router's settings, or it may change and the app stops reaching Chrome.
2. **Pass the port on and let only the server in (once).** In PowerShell as administrator, with your laptop's address after `listenaddress=` and your server's after `-RemoteAddress`:
   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=192.168.0.57 listenport=9222 connectaddress=127.0.0.1 connectport=9222
   New-NetFirewallRule -DisplayName "Chrome for Apply" -Direction Inbound -Protocol TCP -LocalPort 9222 -RemoteAddress 192.168.0.246 -Action Allow
   ```
   Passing the port on needs the **IP Helper** service, which runs on Windows by default. On a work laptop, company policy may block either line: then use Tailscale, or another computer.
3. **Tell the app.** Start **Chrome for Apply** and enter the laptop's address under **Browser window**, such as `http://192.168.0.57:9222`, then click **Test** and **Save**.

To undo it later:
```powershell
netsh interface portproxy delete v4tov4 listenaddress=192.168.0.57 listenport=9222
Remove-NetFirewallRule -DisplayName "Chrome for Apply"
```

## First steps in the app

1. **Settings → AI provider**: choose **Groq** and paste a free API key from [console.groq.com](https://console.groq.com), **DeepSeek** with a key from [platform.deepseek.com](https://platform.deepseek.com/api_keys) (pay per use, a few euros go a long way), **Gemini** with a key from [Google AI Studio](https://aistudio.google.com/api-keys) (set up billing there first, so Google doesn't use what it's sent), or **Anthropic** with a key from [platform.claude.com](https://platform.claude.com). Press **Test connection**.
2. **Settings → Job search**: choose **Bundesagentur für Arbeit**, which is free and needs no key, and tick **I understand, and choose this source myself**.
3. **Profile → Import from a resume**: upload your CV and check what it read. Moving over from another computer instead? There, use **Settings → Your data → Export everything** with **Include my API keys** ticked. Here, use **Import** in **Settings → Your data** and choose that file. Delete the file afterwards: it holds your profile and your keys in plain text.
4. **Find jobs**, open a posting and create an application. On its **Apply** tab, **Open and fill it in** opens the employer's form in a browser window and fills it in. Check everything in that window, and press Send yourself.

## Use it from Claude (optional)

The app is also an MCP server, so Claude, Gemini CLI or another MCP client can work in it for you: search one or several job sources, add jobs it found on the web, change your profile, write, ATS-check and send applications, fill in forms on the Apply tab, and more.

1. In the app, open **Settings → MCP connector** and turn it on.
2. In Claude Code on this laptop, run this once, then type `/mcp` in Claude Code and sign in when the browser opens:

```powershell
claude mcp add --transport http dossier http://localhost:3000/api/mcp
```

3. Claude Desktop on the same laptop reaches it through `mcp-remote`, which needs Node.js. In **Settings → Developer → Edit Config**, add this to `claude_desktop_config.json`, restart Claude Desktop and sign in when the browser opens:

```json
{
  "mcpServers": {
    "dossier": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/api/mcp", "--allow-http"] }
  }
}
```

4. Gemini CLI: add the server to `%USERPROFILE%\.gemini\settings.json`, start `gemini`, trust the folder you run it in (Gemini CLI turns MCP servers off in untrusted folders) and sign in with `/mcp auth dossier`:

```json
{
  "mcpServers": {
    "dossier": { "httpUrl": "http://localhost:3000/api/mcp" }
  }
}
```

claude.ai and the Claude mobile apps reach the app from Anthropic's servers, so they need an internet address with HTTPS, for example through Tailscale Funnel. On a Team or Enterprise plan, only an Owner can add the connector there.

After updating the app, reconnect each client (`/mcp` → reconnect in Claude Code and Gemini CLI, a restart of Claude Desktop): they keep the tool list they got when they connected, so new tools and options only show after that.

Claude Code asks you before it uses a tool, unless you've allowed that tool for good, so keep sending and deleting tools on ask. Claude never sees your API keys or your password through the connector.

## Updating to a new version

Stop the app with **Ctrl+C**, then:

```powershell
cd $HOME\jobauto
git pull
yarn install
yarn generate
yarn prisma migrate deploy
```

Start it again as in step 5. Your data stays in your own database.

## If something goes wrong

- **"running scripts is disabled on this system"**: run the `Set-ExecutionPolicy` line from step 1 again.
- **"Can't reach database server"** or **"Authentication failed"**: the password in `DATABASE_URL` isn't your PostgreSQL password, or PostgreSQL isn't running. Open **Services** from the Start menu and start **postgresql-x64-18**.
- **"That's not the password set on the server"**: run `yarn hash-password` again, replace the `DOSSIER_PASSWORD` line in `.env`, and restart the app.
- **"Port 3000 is in use"**: the app is already running in another window. Use that one, or close it first.
- **An error page right after updating**: stop the app with **Ctrl+C** and start it again.
- **PDFs don't download**: the app prints them with Chrome or Edge. Edge comes with Windows; if it was removed, install Chrome.
- **"yarn is not recognized"**: run `npm install -g corepack` and `corepack enable` again, then close and reopen PowerShell.

With the zip installer:

- **The installer window closes at once**: `Install.cmd` was run from inside the zip. Extract the zip first, then run it from the extracted folder.
- **"Windows protected your PC"**: click **More info**, then **Run anyway**. The scripts are plain text in the `app\installer` folder, if you want to read what they do.
- **"Something is listening on port 3000"** from Install or Update: the app is running. Close the Jobauto window first.
- **"Node.js was installed but isn't found yet"**: restart the computer and run `Install.cmd` again; it continues where it stopped.
- **The installation stopped** with another message: read it, fix the cause, and run `Install.cmd` again. Every step checks what's already done. `install.log` in `%LOCALAPPDATA%\Jobauto` has the details.
