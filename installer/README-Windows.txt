jobauto for Windows
===================

Your job search on your own computer: one password, your data in a database
on this machine, and an AI model you choose. https://github.com/vishnucta/jobauto

Install
  1. Extract this zip somewhere (right-click, Extract All).
  2. Double-click Install.cmd. If Windows says "Windows protected your PC",
     click "More info", then "Run anyway". Click Yes when it asks to allow changes.
  3. Type the password you want to sign in with, twice. Nothing else is asked.
  4. Wait. It installs Node.js and PostgreSQL, the app's packages, and the app
     itself: 10 to 15 minutes on a normal laptop and connection.
  5. The browser opens at http://localhost:3000. Sign in with your password.

Then, in the app: Settings > AI provider (a key from Groq, DeepSeek or
Anthropic), Settings > Job search, and Profile > Import from a resume.
The full guide, with troubleshooting, is INSTALL.md in the app folder, or
https://github.com/vishnucta/jobauto/blob/main/INSTALL.md

Daily use
  Double-click Jobauto on the Desktop. A black window stays open while you use
  the app; close it to stop.

Where things are
  %LOCALAPPDATA%\Jobauto          the app (app\), your settings (app\.env),
                                  backups and exports (data\), the log
  Update.cmd                      fetches and installs the latest release;
                                  settings and data stay
  Uninstall.cmd                   removes the app and shortcuts; asks before
                                  deleting the database

The app needs Microsoft Edge or Google Chrome for PDFs and the Apply tab.
Edge comes with Windows. Node.js and PostgreSQL are installed for the whole
computer; Uninstall leaves them (Settings > Apps removes them).

Once a day, after you say yes to the question in the app, it sends upstream
Dossier a random install ID and its version number, nothing else. Say no and
it sends nothing.
