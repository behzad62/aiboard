# CI only (runner-installer workflow, acceptance T11): creates a throwaway STANDARD (non-admin) Windows user and runs
# the real one-liner as that user against the test release served by installer-e2e.mts --serve-only, then checks
# that the install worked without admin rights, landed on that user's PATH, and uninstalls cleanly.
param([string]$Origin = 'http://127.0.0.1:8765', [string]$Out = 'C:\aibtest-out')
$ErrorActionPreference = 'Stop'
$user = 'aibtest'
$password = 'Aa1!' + [Guid]::NewGuid().ToString('N')
net user $user $password /add /y | Out-Null
try {
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  icacls $Out /grant "${user}:(OI)(CI)M" | Out-Null
  $script = @"
`$ErrorActionPreference = 'Continue'
try { irm $Origin/install.ps1 | iex; 'INSTALL_OK' } catch { 'INSTALL_FAILED: ' + `$_ }
`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
'VERSION: ' + (aiboard version | Out-String).Trim()
'ADMIN: ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
'USERPATH: ' + [Environment]::GetEnvironmentVariable('Path','User')
aiboard uninstall --yes | Out-Null
'UNINSTALL_EXIT: ' + `$LASTEXITCODE
"@
  Set-Content -LiteralPath (Join-Path $Out 'run.ps1') -Value $script -Encoding ASCII
  $credential = New-Object Management.Automation.PSCredential($user, (ConvertTo-SecureString $password -AsPlainText -Force))
  $process = Start-Process -FilePath powershell.exe -Credential $credential -LoadUserProfile -WorkingDirectory $Out -Wait -PassThru `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Out 'run.ps1') `
    -RedirectStandardOutput (Join-Path $Out 'result.txt') -RedirectStandardError (Join-Path $Out 'error.txt')
  $result = Get-Content -Raw -LiteralPath (Join-Path $Out 'result.txt')
  Write-Host $result
  Write-Host (Get-Content -Raw -LiteralPath (Join-Path $Out 'error.txt') -ErrorAction SilentlyContinue)
  $failures = @()
  if ($process.ExitCode -ne 0) { $failures += "run.ps1 exited $($process.ExitCode)" }
  if ($result -notmatch 'INSTALL_OK') { $failures += 'installer did not complete' }
  if ($result -notmatch 'VERSION: AIBoard Runner V2 0\.9\.1') { $failures += 'aiboard was not on the standard user PATH' }
  if ($result -notmatch 'ADMIN: False') { $failures += 'the test user was an administrator' }
  if ($result -notmatch 'USERPATH: .*AIBoard\\bin') { $failures += 'the user PATH did not contain AIBoard\bin' }
  if ($result -notmatch 'UNINSTALL_EXIT: 0') { $failures += 'uninstall failed' }
  if ($failures.Count -gt 0) { throw ("Standard-user install failed: " + ($failures -join '; ')) }
  Write-Host 'PASS standard (non-admin) Windows user installed, ran and uninstalled AI Board Runner'
} finally {
  net user $user /delete | Out-Null
}
