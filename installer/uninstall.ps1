<#
  jobauto for Windows: remove the app.

  Run through Uninstall.cmd next to the installed app. Removes the shortcuts
  and the install folder, and offers to delete the database. Node.js and
  PostgreSQL stay: other software may use them (Settings > Apps removes them).
#>
[CmdletBinding()]
param(
  # Answer every question with yes (tests).
  [switch]$Yes,
  # With -Yes: also delete the database.
  [switch]$DropDatabase,
  # Tests only: go ahead even while something listens on port 3000.
  [switch]$IgnoreRunning
)

$ErrorActionPreference = "Stop"
$installDir = Split-Path -Parent $PSScriptRoot

function Fail([string]$Message) { throw $Message }
function Confirm([string]$Question, [bool]$Default) {
  if ($Yes) { return $true }
  $hint = if ($Default) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "$Question $hint"
  if ($answer -eq "") { return $Default }
  return $answer -match "^[yY]"
}

try {
  if (-not $IgnoreRunning -and (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) { Fail "The app is running. Close the Jobauto window first, then run Uninstall again." }
  Write-Host "This removes Jobauto from $installDir, with its shortcuts." -ForegroundColor Yellow
  if (-not (Confirm "Go ahead?" $false)) { Write-Host "Nothing was removed."; exit 0 }

  # The database, only when asked.
  $envPath = Join-Path $installDir "app\.env"
  $drop = $false
  if ($Yes) { $drop = [bool]$DropDatabase }
  elseif (Test-Path $envPath) {
    Write-Host "Your profile, applications and documents are in the PostgreSQL database. To keep a copy, start the app first and use Settings > Your data > Export everything."
    $drop = Confirm "Delete the database too?" $false
  }
  if ($drop -and (Test-Path $envPath)) {
    $line = [IO.File]::ReadAllLines($envPath) | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
    $url = $null
    if ($line) { $url = ($line -replace "^DATABASE_URL=", "").Trim('"', "'") }
    $psql = Get-ChildItem "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($url -and $psql) {
      $uri = [Uri]$url
      $user, $password = $uri.UserInfo.Split(":", 2)
      $database = $uri.AbsolutePath.TrimStart("/")
      $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
      $env:PGPASSWORD = [Uri]::UnescapeDataString($password)
      & $psql.FullName -U $user -h $uri.Host -p $port -d postgres -q -c ('DROP DATABASE IF EXISTS "{0}"' -f $database)
      $env:PGPASSWORD = $null
      if ($LASTEXITCODE -eq 0) { Write-Host "Deleted the database $database." } else { Write-Host "Couldn't delete the database $database (see above). Everything else is removed." -ForegroundColor Yellow }
    } else {
      Write-Host "Couldn't find the database address or PostgreSQL's tools; the database stays." -ForegroundColor Yellow
    }
  }

  foreach ($folder in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
    Remove-Item (Join-Path $folder "Jobauto.lnk") -Force -ErrorAction SilentlyContinue
  }

  Set-Location $env:TEMP
  try { Remove-Item -LiteralPath $installDir -Recurse -Force }
  catch { & cmd.exe /c rmdir /s /q "$installDir" | Out-Null }
  if (Test-Path $installDir) { Fail "Some files in $installDir couldn't be removed. Close every window that uses them and delete the folder by hand." }

  Write-Host "Jobauto is removed. Node.js and PostgreSQL stay installed; remove them in Settings > Apps if nothing else needs them." -ForegroundColor Green
  exit 0
} catch {
  Write-Host ""
  Write-Host "Removing stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
