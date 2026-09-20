$ErrorActionPreference = "Stop"

[IO.File]::WriteAllText(
    $env:LSP_FIXTURE_STALLED_JOB_HOST_PID_FILE,
    [string]$PID
)

while ($true) {
    Start-Sleep -Milliseconds 100
}
