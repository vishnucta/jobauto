# Opens the browser once the app answers, instead of before it's ready.
# Started hidden by Jobauto.cmd; gives up (and opens the address anyway) after the timeout.
param(
  [string]$Url = "http://localhost:3000",
  [int]$TimeoutSeconds = 180
)
$ProgressPreference = "SilentlyContinue"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) { Start-Process $Url; exit 0 }
  } catch {}
  Start-Sleep -Seconds 2
}
Start-Process $Url
