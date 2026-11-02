<#
  jobauto for Windows: update to the latest release.

  Run through Update.cmd next to the installed app. Fetches the newest
  jobauto-windows-*.zip from the GitHub releases page (or uses a zip you
  downloaded, with -Zip), unpacks it and runs its installer against this
  install, which keeps the settings file and the database.
#>
[CmdletBinding()]
param(
  # A downloaded zip to update from, instead of fetching the latest release.
  [string]$Zip,
  [string]$Repo = "vishnucta/jobauto"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$installDir = Split-Path -Parent $PSScriptRoot

function Fail([string]$Message) { throw $Message }

try {
  if (-not (Test-Path (Join-Path $installDir "app\.env"))) { Fail "No installed app found at $installDir. Run Install.cmd from a downloaded zip instead." }
  if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { Fail "The app is running. Close the Jobauto window first, then run Update again." }

  $installed = ""
  $versionFile = Join-Path $installDir "VERSION"
  if (Test-Path $versionFile) { $installed = ([IO.File]::ReadAllText($versionFile)).Trim() }

  if (-not $Zip) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Looking for the latest release of $Repo..."
    try {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "jobauto-update" } -UseBasicParsing
    } catch {
      Fail "Couldn't read the releases page (is the computer online?). You can also download the zip from https://github.com/$Repo/releases and run its Install.cmd: that updates too."
    }
    $asset = $release.assets | Where-Object { $_.name -like "jobauto-windows-*.zip" } | Select-Object -First 1
    if (-not $asset) { Fail "The latest release ($($release.tag_name)) has no Windows zip." }
    $latest = ($release.tag_name -replace "^jobauto-", "") -replace "^v", ""
    if ($installed -and ($installed -eq $latest)) {
      Write-Host "Already up to date: version $installed." -ForegroundColor Green
      exit 0
    }
    Write-Host "Installed: $(if ($installed) { $installed } else { 'unknown' }). Latest: $latest. Downloading $($asset.name)..."
    $Zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $Zip -UseBasicParsing
  }
  if (-not (Test-Path $Zip)) { Fail "There's no file at $Zip." }

  $stage = Join-Path $env:TEMP ("jobauto-update-" + [guid]::NewGuid().ToString("N"))
  Write-Host "Unpacking..."
  Expand-Archive -LiteralPath $Zip -DestinationPath $stage -Force
  $installer = Get-ChildItem -Path $stage -Recurse -Filter "install.ps1" | Select-Object -First 1
  if (-not $installer) { Fail "That zip has no installer in it." }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer.FullName -InstallDir $installDir -NoStart
  $code = $LASTEXITCODE
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) { Fail "The installer reported a problem (see above)." }
  Write-Host "Updated. Double-click Jobauto to start it." -ForegroundColor Green
  exit 0
} catch {
  Write-Host ""
  Write-Host "The update stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
