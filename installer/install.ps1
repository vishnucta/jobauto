<#
  jobauto for Windows: the installer.

  Run it by double-clicking Install.cmd at the top of the downloaded zip, or:

    powershell -NoProfile -ExecutionPolicy Bypass -File app\installer\install.ps1

  What it does, in order:
    1. checks this computer (Windows 10 1809 or newer, winget, disk space, Edge or Chrome);
    2. installs Node.js and PostgreSQL 18 with winget when they're missing, in a second
       window with administrator rights (the only part that needs them);
    3. copies the app to %LOCALAPPDATA%\Jobauto\app;
    4. installs Yarn through Corepack and the app's packages;
    5. writes the settings file (.env): a hash of the sign-in password you choose,
       a random secret and the database address;
    6. creates the database and loads the built-in themes;
    7. puts a Jobauto shortcut on the Desktop and in the Start menu.

  Running it again on an existing install updates the app and keeps the settings
  file and the database. Every step checks before it acts, so a run that stopped
  can be started again.

  Unattended (tests, CI):
    install.ps1 -NonInteractive -Password ... -DatabaseUrl postgresql://... -SkipTools -NoShortcuts -NoStart
#>
[CmdletBinding()]
param(
  # Where the app goes. Settings and data live here too, so updates can replace app\ alone.
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Jobauto"),
  # The sign-in password, for unattended runs. Asked for (twice, hidden) otherwise.
  [string]$Password,
  # Use this PostgreSQL instead of installing one, e.g. postgresql://postgres:secret@localhost:5432/dossier
  [string]$DatabaseUrl,
  # Don't install Node.js or PostgreSQL (they're already there).
  [switch]$SkipTools,
  # Don't create or migrate the database (tests only).
  [switch]$SkipDatabase,
  [switch]$NoShortcuts,
  # Never ask anything; fail instead.
  [switch]$NonInteractive,
  # Don't offer to start the app at the end.
  [switch]$NoStart,
  # Tests only: update even while something listens on port 3000.
  [switch]$IgnoreRunning,
  # Internal: the half that runs with administrator rights.
  [switch]$ToolsOnly,
  [switch]$NeedNode,
  [switch]$NeedPostgres,
  [string]$DbPasswordFile
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# --- Helpers ----------------------------------------------------------------

function Step([string]$Number, [string]$Title) {
  Write-Host ""
  Write-Host "== $Number $Title ==" -ForegroundColor Cyan
}

function Fail([string]$Message) { throw $Message }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# Runs a native program. Programs write progress to stderr, which Windows
# PowerShell turns into errors when the output is redirected; not here.
function Native([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Command } finally { $ErrorActionPreference = $previous }
}

# Runs a program and stops the install when it fails.
function Run([string]$Exe, [string[]]$Arguments, [string]$What) {
  Native { & $Exe @Arguments }
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE). See the messages above." }
}

function Node-Major {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  $version = (& $node.Source -v) -replace "^v", ""
  return [int]($version.Split(".")[0])
}

function Postgres-Service { Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1 }

function Postgres-Psql {
  Get-ChildItem "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }
}

function Port-Listening([int]$Port) {
  $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# Letters and digits only: safe in a connection string and in winget's --override.
function Random-Token([int]$Length) {
  $alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $bytes = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Random-Hex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

function Plain([System.Security.SecureString]$Secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Ask-Hidden([string]$Prompt) { return Plain (Read-Host -AsSecureString $Prompt) }

function Write-Utf8([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding $false))
}

# Batch files want CRLF line endings whatever the zip or git delivered.
function Copy-Batch([string]$From, [string]$To) {
  $text = [IO.File]::ReadAllText($From) -replace "`r`n", "`n" -replace "`n", "`r`n"
  [IO.File]::WriteAllText($To, $text, [System.Text.Encoding]::ASCII)
}

function Browser-Present {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($path in $candidates) { if (Test-Path $path) { return $true } }
  return $false
}

# winget's "nothing to do" codes count as success: the package is there already.
$wingetOk = @(0, -1978335189, -1978335135)

# --- The elevated half: Node.js and PostgreSQL ------------------------------

if ($ToolsOnly) {
  try {
    $logDir = Split-Path -Parent $DbPasswordFile
    if ($DbPasswordFile -and (Test-Path $logDir)) {
      try { Start-Transcript -Path (Join-Path $logDir "install-tools.log") -Append | Out-Null } catch {}
    }
    Write-Host "Installing tools with administrator rights. This window closes by itself when done." -ForegroundColor Cyan
    # winget when it's there; otherwise the installers straight from nodejs.org and EDB,
    # for a Windows that never got the App Installer.
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { Write-Host "winget isn't available here: downloading the installers directly instead." -ForegroundColor Yellow }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $downloads = Join-Path $env:TEMP "jobauto-installers"
    if (-not (Test-Path $downloads)) { New-Item -ItemType Directory -Path $downloads | Out-Null }

    if ($NeedNode) {
      Step "a" "Node.js (LTS)"
      if ($winget) {
        & $winget.Source install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --disable-interactivity
        if ($wingetOk -notcontains $LASTEXITCODE) { Fail "winget couldn't install Node.js (exit code $LASTEXITCODE)." }
      } else {
        $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
        $lts = $index | Where-Object { $_.lts -ne $false -and $_.files -contains "win-x64-msi" } | Select-Object -First 1
        if (-not $lts) { Fail "Couldn't find a Node.js LTS release to download." }
        $msi = Join-Path $downloads "node-$($lts.version)-x64.msi"
        Write-Host "Downloading Node.js $($lts.version)..."
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" -OutFile $msi -UseBasicParsing
        $setup = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", ('"{0}"' -f $msi), "/qn", "/norestart") -Wait -PassThru
        if (@(0, 3010) -notcontains $setup.ExitCode) { Fail "The Node.js installer failed (exit code $($setup.ExitCode))." }
      }
    }

    if ($NeedPostgres) {
      Step "b" "PostgreSQL 18"
      $dbPassword = ([IO.File]::ReadAllText($DbPasswordFile)).Trim()
      $override = "--mode unattended --unattendedmodeui none --superpassword $dbPassword --serverport 5432 --enable-components server,commandlinetools"
      if ($winget) {
        & $winget.Source install -e --id PostgreSQL.PostgreSQL.18 --accept-source-agreements --accept-package-agreements --disable-interactivity --override $override
        if ($wingetOk -notcontains $LASTEXITCODE) { Fail "winget couldn't install PostgreSQL (exit code $LASTEXITCODE)." }
      } else {
        # EDB's installer, the same one winget uses. Newest known 18.x first; any 18 does.
        $exe = $null
        foreach ($candidate in @("18.2-1", "18.1-1", "18.0-1")) {
          $url = "https://get.enterprisedb.com/postgresql/postgresql-$candidate-windows-x64.exe"
          try { Invoke-WebRequest -Method Head -Uri $url -UseBasicParsing -TimeoutSec 20 | Out-Null } catch { continue }
          $exe = Join-Path $downloads "postgresql-$candidate-windows-x64.exe"
          Write-Host "Downloading PostgreSQL $candidate (about 350 MB)..."
          Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
          break
        }
        if (-not $exe) { Fail "Couldn't download PostgreSQL. Install it from https://www.postgresql.org/download/windows/ (remember the password you choose), then run Install.cmd again." }
        $setup = Start-Process -FilePath $exe -ArgumentList $override -Wait -PassThru
        if ($setup.ExitCode -ne 0) { Fail "The PostgreSQL installer failed (exit code $($setup.ExitCode))." }
      }
      $service = Postgres-Service
      if (-not $service) { Fail "PostgreSQL was installed, but its Windows service isn't there." }
      if ($service.Status -ne "Running") { Start-Service $service.Name }
    }

    Write-Host "Tools installed." -ForegroundColor Green
    try { Stop-Transcript | Out-Null } catch {}
    exit 0
  } catch {
    Write-Host ""
    Write-Host "Installing the tools stopped: $($_.Exception.Message)" -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    Start-Sleep -Seconds 8
    exit 1
  }
}

# --- The install -------------------------------------------------------------

$transcript = $false
try {
  $here = $PSScriptRoot                       # app\installer, in the zip or in a clone
  $sourceApp = Split-Path -Parent $here       # app\
  $sourceRoot = Split-Path -Parent $sourceApp # the zip's top folder (has VERSION) or the clone's parent
  if (-not (Test-Path (Join-Path $sourceApp "package.json"))) { Fail "The app's files aren't next to this script. Extract the whole zip, then run Install.cmd from it." }

  $appDir = Join-Path $InstallDir "app"
  $envPath = Join-Path $appDir ".env"
  $dataDir = Join-Path $InstallDir "data"
  $existing = Test-Path $envPath
  $inPlace = (Resolve-Path $sourceApp).Path.TrimEnd("\") -ieq $appDir.TrimEnd("\")
  $interactive = -not $NonInteractive

  Write-Host ""
  Write-Host "Jobauto for Windows" -ForegroundColor Green
  if ($existing) { Write-Host "Updating the app in $InstallDir. Your settings and your data stay." }
  else { Write-Host "Installing the app to $InstallDir." }

  if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir | Out-Null }
  try { Start-Transcript -Path (Join-Path $InstallDir "install.log") -Append | Out-Null; $transcript = $true } catch {}

  # 1. This computer -----------------------------------------------------------
  Step "1/7" "Checking this computer"
  $build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
  if ($build -lt 17763) { Fail "Windows 10 version 1809 or newer is needed (this is build $build)." }
  if (Port-Listening 3000) {
    if ($existing -and -not $IgnoreRunning) { Fail "Something is listening on port 3000, probably the app itself. Close the Jobauto window, then run this again." }
    Write-Host "Something else is listening on port 3000. The app will take the next free port when it starts; the browser may need the address from its window." -ForegroundColor Yellow
  }
  $drive = Get-PSDrive -Name ($InstallDir.Substring(0, 1)) -ErrorAction SilentlyContinue
  if ($drive -and $drive.Free -lt 3GB) { Write-Host "Only $([math]::Round($drive.Free / 1GB, 1)) GB free on drive $($drive.Name): the app needs about 3 GB." -ForegroundColor Yellow }
  if (-not (Browser-Present)) { Write-Host "Neither Microsoft Edge nor Google Chrome was found. The app needs one of them for PDFs and the Apply tab: install Chrome before you use those." -ForegroundColor Yellow }

  $nodeOk = (Node-Major) -ge 24
  $postgresPresent = ($null -ne (Postgres-Service)) -or (Port-Listening 5432)
  $needNode = -not $nodeOk
  $needPostgres = -not $postgresPresent -and -not $DatabaseUrl -and -not $existing
  if ($SkipTools) {
    if ($needNode) { Fail "Node.js 24 or newer is needed, and -SkipTools was given." }
    $needPostgres = $false
  }
  if (($needNode -or $needPostgres) -and -not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Write-Host "winget (the App Installer) isn't on this computer: Node.js and PostgreSQL will be downloaded from their own sites instead." -ForegroundColor Yellow
  }
  if ($nodeOk) { Write-Host "Node.js $(node -v) is installed." } else { Write-Host "Node.js: will be installed." }
  if ($postgresPresent) { Write-Host "PostgreSQL is installed." } elseif ($needPostgres) { Write-Host "PostgreSQL 18: will be installed." } else { Write-Host "PostgreSQL: using the address given." }

  # 2. Node.js and PostgreSQL ------------------------------------------------------
  Step "2/7" "Node.js and PostgreSQL"
  $dbPassword = $null
  if ($needNode -or $needPostgres) {
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $PSCommandPath), "-ToolsOnly")
    if ($needNode) { $arguments += "-NeedNode" }
    $passwordFile = Join-Path $InstallDir "pg-setup.tmp"
    if ($needPostgres) {
      $dbPassword = Random-Token 24
      Write-Utf8 $passwordFile $dbPassword
      $arguments += @("-NeedPostgres", "-DbPasswordFile", ('"{0}"' -f $passwordFile))
    } else {
      $arguments += @("-DbPasswordFile", ('"{0}"' -f $passwordFile))
    }
    Write-Host "Windows will ask whether this installer may make changes to your device: click Yes. A second window installs the tools; wait until it closes."
    try {
      $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    } catch {
      Remove-Item $passwordFile -Force -ErrorAction SilentlyContinue
      Fail "Administrator permission was refused, and it's needed to install Node.js and PostgreSQL."
    }
    Remove-Item $passwordFile -Force -ErrorAction SilentlyContinue
    if ($process.ExitCode -ne 0) { Fail "Installing Node.js or PostgreSQL didn't finish (see install-tools.log in $InstallDir). Run Install.cmd again; if it keeps failing, install them by hand as INSTALL.md describes and run it with -SkipTools." }
    Refresh-Path
    if ((Node-Major) -lt 24) { Fail "Node.js was installed but isn't found yet. Restart the computer, then run Install.cmd again." }
    if ($needPostgres -and -not (Postgres-Service)) { Fail "PostgreSQL was installed but its service isn't found. Restart the computer, then run Install.cmd again." }
    Write-Host "Node.js $(node -v) is ready."
  } else {
    Write-Host "Nothing to install."
  }

  # 3. App files ----------------------------------------------------------------
  Step "3/7" "App files"
  if ($inPlace) {
    Write-Host "Running from the installed copy: repairing it in place."
  } else {
    if (-not (Test-Path $appDir)) { New-Item -ItemType Directory -Path $appDir | Out-Null }
    if ($existing) {
      # Out with the old version, except what the person owns and what makes updates quick.
      $keep = @(".env", "node_modules", ".next")
      Get-ChildItem -Path $appDir -Force | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force
    }
    $exclude = @(
      (Join-Path $sourceApp "node_modules"), (Join-Path $sourceApp ".next"), (Join-Path $sourceApp ".git"),
      (Join-Path $sourceApp "coverage"), (Join-Path $sourceApp "data"), (Join-Path $sourceApp "_site"),
      (Join-Path $sourceApp "playwright-report"), (Join-Path $sourceApp "test-results"), (Join-Path $sourceApp "dist"),
      (Join-Path $sourceApp "apply"), (Join-Path $sourceApp "apply-browser"),
      (Join-Path $sourceApp "scripts\local"), (Join-Path $sourceApp "e2e\.auth")
    )
    Native { & robocopy.exe $sourceApp $appDir /E /XD @exclude /XF ".env" ".env.local" /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null }
    if ($LASTEXITCODE -ge 8) { Fail "Copying the app's files failed (robocopy exit code $LASTEXITCODE)." }
    Write-Host "Copied the app to $appDir."
  }
  $installerDir = Join-Path $InstallDir "installer"
  if (-not (Test-Path $installerDir)) { New-Item -ItemType Directory -Path $installerDir | Out-Null }
  Get-ChildItem -Path (Join-Path $appDir "installer") -Filter "*.ps1" | ForEach-Object { Copy-Item $_.FullName (Join-Path $installerDir $_.Name) -Force }
  foreach ($batch in @("Jobauto.cmd", "Update.cmd", "Uninstall.cmd")) {
    Copy-Batch (Join-Path $appDir "installer\$batch") (Join-Path $InstallDir $batch)
  }
  Get-ChildItem -Path $InstallDir -Include "*.ps1", "*.cmd" -Recurse -Depth 1 | Unblock-File -ErrorAction SilentlyContinue
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  $versionFile = Join-Path $sourceRoot "VERSION"
  if (Test-Path $versionFile) { Copy-Item $versionFile (Join-Path $InstallDir "VERSION") -Force }
  else { Write-Utf8 (Join-Path $InstallDir "VERSION") ("dev " + (Get-Date -Format "yyyy-MM-dd")) }

  # 4. Yarn and packages ---------------------------------------------------------------
  Step "4/7" "Yarn and the app's packages (a few minutes)"
  Set-Location $appDir
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
  $npmBin = Join-Path $env:APPDATA "npm"
  $corepack = Join-Path $npmBin "corepack.cmd"
  if (-not (Test-Path $corepack)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { Fail "npm wasn't found next to Node.js." }
    Run $npm.Source @("install", "-g", "corepack") "Installing Corepack"
  }
  if (-not (Test-Path $corepack)) { Fail "Corepack didn't land in $npmBin." }
  # Shims in the per-user npm folder: no administrator rights, and it's on the PATH.
  Run $corepack @("enable", "--install-directory", $npmBin) "Enabling Yarn through Corepack"
  $yarn = Join-Path $npmBin "yarn.cmd"
  if (-not (Test-Path $yarn)) { Fail "Yarn's launcher didn't appear in $npmBin." }
  Run $yarn @("install", "--immutable") "Installing the app's packages"

  # 5. Settings ------------------------------------------------------------------------------
  Step "5/7" "Your settings"
  if ($existing) {
    Write-Host "Keeping your settings file ($envPath)."
  } else {
    if (-not $Password) {
      if (-not $interactive) { Fail "Pass -Password for an unattended install." }
      Write-Host "Choose the password you'll sign in to the app with. You won't see it while you type."
      while ($true) {
        $first = Ask-Hidden "Password"
        if ($first.Length -lt 8) { Write-Host "Make it at least 8 characters." -ForegroundColor Yellow; continue }
        $second = Ask-Hidden "Same again"
        if ($first -ceq $second) { $Password = $first; break }
        Write-Host "They don't match. Once more." -ForegroundColor Yellow
      }
    }
    $previousEncoding = $OutputEncoding
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    try { $hash = Native { $Password | & $yarn hash-password } | Where-Object { "$_" -match "^argon2id:" } | Select-Object -Last 1 }
    finally { $OutputEncoding = $previousEncoding }
    if (-not $hash) { Fail "Making the password hash failed (see the messages above)." }

    if (-not $DatabaseUrl) {
      if ($dbPassword) {
        $DatabaseUrl = "postgresql://postgres:$dbPassword@localhost:5432/dossier"
      } else {
        if (-not $interactive) { Fail "PostgreSQL is already on this computer: pass -DatabaseUrl with its address and password." }
        Write-Host "PostgreSQL is already installed. The app needs the password of its 'postgres' user, chosen when PostgreSQL was installed."
        $psql = Postgres-Psql
        $tries = 0
        while ($true) {
          $tries++
          $given = Ask-Hidden "Password of the PostgreSQL user 'postgres'"
          if (-not $psql) { break }
          $env:PGPASSWORD = $given
          Native { & $psql -U postgres -h localhost -p 5432 -d postgres -q -t -c "select 1" | Out-Null }
          $env:PGPASSWORD = $null
          if ($LASTEXITCODE -eq 0) { break }
          if ($tries -ge 3) { Fail "PostgreSQL didn't accept that password three times. In Settings > Apps you can remove PostgreSQL and run Install.cmd again, which installs it fresh." }
          Write-Host "PostgreSQL didn't accept that password. Try again." -ForegroundColor Yellow
        }
        $DatabaseUrl = "postgresql://postgres:$([Uri]::EscapeDataString($given))@localhost:5432/dossier"
      }
    }

    $secret = Random-Hex 32
    $lines = [IO.File]::ReadAllLines((Join-Path $appDir ".env.example"))
    $set = @{ "DOSSIER_PASSWORD" = $hash; "DOSSIER_SECRET" = $secret; "DATABASE_URL" = ('"{0}"' -f $DatabaseUrl); "DOSSIER_DATA_DIR" = $dataDir }
    $done = @{}
    $out = foreach ($line in $lines) {
      $written = $false
      foreach ($key in $set.Keys) {
        if ($line -match ('^#?\s*' + [regex]::Escape($key) + '=')) { "$key=$($set[$key])"; $done[$key] = $true; $written = $true; break }
      }
      if (-not $written) { $line }
    }
    foreach ($key in $set.Keys) { if (-not $done[$key]) { $out += "$key=$($set[$key])" } }
    Write-Utf8 $envPath (($out -join "`r`n") + "`r`n")
    try { Native { & icacls.exe $envPath /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(R,W)" | Out-Null } } catch {}
    Write-Host "Wrote $envPath. It holds your sign-in and the key to the API keys the app saves: keep it, and keep it private."
  }

  # 6. Database -----------------------------------------------------------------------------
  Step "6/7" "Database"
  if ($SkipDatabase) {
    Write-Host "Skipped (-SkipDatabase)."
  } else {
    $service = Postgres-Service
    if ($service -and $service.Status -ne "Running") {
      try { Start-Service $service.Name } catch { Write-Host "PostgreSQL's service ($($service.Name)) isn't running and couldn't be started from here." -ForegroundColor Yellow }
    }
    Run $yarn @("prisma", "generate") "Preparing the database client"
    Run $yarn @("prisma", "migrate", "deploy") "Creating or updating the database"
    Run $yarn @("prisma", "db", "seed") "Loading the built-in themes"
  }

  # 7. Shortcuts ---------------------------------------------------------------------------------
  Step "7/7" "Shortcuts"
  if ($NoShortcuts) {
    Write-Host "Skipped (-NoShortcuts)."
  } else {
    $shell = New-Object -ComObject WScript.Shell
    $icon = Join-Path $appDir "src\app\favicon.ico"
    foreach ($folder in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
      $link = $shell.CreateShortcut((Join-Path $folder "Jobauto.lnk"))
      $link.TargetPath = Join-Path $InstallDir "Jobauto.cmd"
      $link.WorkingDirectory = $InstallDir
      $link.Description = "Jobauto: your job search, on this computer"
      if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
      $link.Save()
    }
    Write-Host "Jobauto is on the Desktop and in the Start menu."
  }

  Write-Host ""
  Write-Host "Done. Double-click Jobauto to start the app; it opens http://localhost:3000 in your browser." -ForegroundColor Green
  Write-Host "Sign in with the password you chose. Then: Settings > AI provider, Settings > Job search, and import your CV on Profile."
  if ($transcript) { try { Stop-Transcript | Out-Null } catch {}; $transcript = $false }

  if ($interactive -and -not $NoStart) {
    $answer = Read-Host "Start Jobauto now? [Y/n]"
    if ($answer -eq "" -or $answer -match "^[yY]") { Start-Process -FilePath (Join-Path $InstallDir "Jobauto.cmd") -WorkingDirectory $InstallDir }
  }
  exit 0
} catch {
  Write-Host ""
  Write-Host "The installation stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Nothing you'd lose was changed. Fix the cause, then run Install.cmd again: it continues where it stopped. The log is install.log in $InstallDir."
  if ($transcript) { try { Stop-Transcript | Out-Null } catch {} }
  exit 1
}
