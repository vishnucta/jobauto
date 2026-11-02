<#
  Builds the Windows zip: jobauto-windows-<version>.zip in dist\.

  Run from a clone, on any machine with git and PowerShell:

    powershell -ExecutionPolicy Bypass -File installer\make-bundle.ps1 -Version 2026.11.0

  The zip holds Install.cmd, README-Windows.txt, VERSION and app\ (git archive of
  the given ref: tracked files only, so no .env, node_modules or personal data).
#>
[CmdletBinding()]
param(
  [string]$Version = (Get-Date -Format "yyyy.MM.dd"),
  [string]$Ref = "HEAD",
  [string]$Out = "dist"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

git rev-parse --verify --quiet "$Ref^{commit}" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Ref isn't a commit in this repository." }

$name = "jobauto-windows-$Version"
$stage = Join-Path $env:TEMP ("jobauto-bundle-" + [guid]::NewGuid().ToString("N"))
$root = Join-Path $stage $name
$appDir = Join-Path $root "app"
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
try {
  $archive = Join-Path $stage "src.zip"
  git archive --format=zip -o $archive $Ref
  if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
  Expand-Archive -LiteralPath $archive -DestinationPath $appDir -Force
  # Not needed to run the app: the README's screenshots, the website, planning docs.
  foreach ($extra in @(".github", "site", "docs", "design")) {
    $path = Join-Path $appDir $extra
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
  }

  # Batch files get CRLF whatever git delivered.
  $install = [IO.File]::ReadAllText((Join-Path $appDir "installer\Install.cmd")) -replace "`r`n", "`n" -replace "`n", "`r`n"
  [IO.File]::WriteAllText((Join-Path $root "Install.cmd"), $install, [System.Text.Encoding]::ASCII)
  $readme = [IO.File]::ReadAllText((Join-Path $appDir "installer\README-Windows.txt")) -replace "`r`n", "`n" -replace "`n", "`r`n"
  [IO.File]::WriteAllText((Join-Path $root "README-Windows.txt"), $readme, (New-Object System.Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $root "VERSION"), "$Version`r`n", [System.Text.Encoding]::ASCII)

  $outDir = Join-Path $repo $Out
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
  $zip = Join-Path $outDir "$name.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  # bsdtar (in Windows since 10 1803) writes a standard zip; Compress-Archive
  # in Windows PowerShell 5.1 writes backslashes into the entry names.
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & $tar.Source -a -c -f $zip -C $stage $name
    if ($LASTEXITCODE -ne 0) { throw "tar failed to write the zip." }
  } else {
    Compress-Archive -Path $root -DestinationPath $zip -CompressionLevel Optimal
  }
  $size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "Built $zip ($size MB) from $Ref." -ForegroundColor Green
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
