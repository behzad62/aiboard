# AI Board Runner installer for Windows (PowerShell 5.1+ or pwsh):
#   irm https://aiboard.me/install.ps1 | iex
# Installs for the current user only (no admin rights) into %LOCALAPPDATA%\AIBoard, verifies the signed
# release manifest and the bundle's SHA-256 before anything is extracted, and adds %LOCALAPPDATA%\AIBoard\bin
# to your user PATH. Set AIBOARD_NO_MODIFY_PATH=1 to leave PATH alone. Uninstall: aiboard uninstall
# This file is generated from scripts/install/install.ps1 by scripts/release/render-installers.mjs.
& {
  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $ManifestUrl = '__AIBOARD_MANIFEST_URL__'
  $ArtifactPrefix = '__AIBOARD_ARTIFACT_PREFIX__'
  $Channel = '__AIBOARD_CHANNEL__'
  $MinSequence = __AIBOARD_MIN_SEQUENCE__
  $AllowLoopback = __AIBOARD_ALLOW_LOOPBACK_PS__
  $TrustedKeys = @(
__AIBOARD_TRUSTED_KEYS_PS__
  )
  $InstallerProtocol = 1

  function Fail([string]$Message) { throw "AIBoard install failed: $Message" }
  function Say([string]$Message) { Write-Host $Message }

  if ((Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) -and -not $IsWindows) { Fail 'this installer is for Windows; on macOS or Linux run: curl -fsSL https://aiboard.me/install.sh | sh' }
  if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'PowerShell 5.1 or newer is required.' }
  if (@($TrustedKeys).Count -eq 0) { Fail 'AI Board Runner has not been released through the installer yet. See https://aiboard.me/runner-guide.' }
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set.' }

  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { $Target = 'win-x64' }
    'ARM64' { $Target = 'win-arm64'; Say 'Note: Windows on Arm is a preview build.' }
    default { Fail "unsupported processor architecture $arch (64-bit x64 or Arm64 Windows is required)." }
  }

  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  function Test-AllowedUrl([string]$Url) {
    if ($Url.StartsWith('https://')) { return $true }
    return ($AllowLoopback -and $Url -match '^http://127\.0\.0\.1:[0-9]{1,5}/')
  }

  function Get-Download([string]$Url, [string]$Path) {
    if (-not (Test-AllowedUrl $Url)) { Fail "refusing a non-HTTPS download: $Url" }
    try { Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -TimeoutSec 600 }
    catch { Fail "could not download $Url ($($_.Exception.Message)). Check your connection and retry; nothing was changed." }
  }

  function Write-Pointer([string]$Path, [string]$Value) {
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, $Value, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) } else { [IO.File]::Move($temporary, $Path) }
  }

  function Read-Pointer([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $value = ([IO.File]::ReadAllText($Path)).Trim()
    if ($value) { return $value } else { return $null }
  }

  function ConvertTo-UtcDate($Value) {
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
    if ([string]$Value -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$') { Fail 'the release manifest has an invalid timestamp.' }
    return [DateTime]::ParseExact([string]$Value, "yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]'AssumeUniversal,AdjustToUniversal')
  }

  $Root = Join-Path $env:LOCALAPPDATA 'AIBoard'
  $Bin = Join-Path $Root 'bin'
  $Versions = Join-Path $Root 'versions'
  $Work = Join-Path ([IO.Path]::GetTempPath()) ("aiboard-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  $Lock = $null
  $staging = $null
  try {
    # 1. Signed manifest: the signature is checked before the bytes are parsed or any URL/hash is used.
    $manifestPath = Join-Path $Work 'manifest.json'
    Get-Download $ManifestUrl $manifestPath
    Get-Download "$ManifestUrl.sig" "$manifestPath.sig"
    $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
    if ($manifestBytes.Length -gt 65536) { Fail 'the release manifest is too large.' }
    try { $signature = [Convert]::FromBase64String(([IO.File]::ReadAllText("$manifestPath.sig")).Trim()) } catch { Fail 'the release signature is not valid base64.' }
    $signer = $null
    foreach ($key in $TrustedKeys) {
      $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
      try {
        $parameters = New-Object Security.Cryptography.RSAParameters
        $parameters.Modulus = [Convert]::FromBase64String($key.Modulus)
        $parameters.Exponent = [Convert]::FromBase64String($key.Exponent)
        $rsa.ImportParameters($parameters)
        if ($rsa.VerifyData($manifestBytes, 'SHA256', $signature)) { $signer = $key.Id; break }
      } finally { $rsa.Dispose() }
    }
    if (-not $signer) { Fail 'the release manifest signature does not verify against the trusted AIBoard release key. Nothing was installed.' }
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'aiboard-runner' -or $manifest.channel -ne $Channel) { Fail 'the release manifest is for another product or channel.' }
    if ($manifest.keyId -ne $signer) { Fail 'the release manifest names a different key than the one that signed it.' }
    if ([int]$manifest.minInstallerVersion -gt $InstallerProtocol) { Fail 'this release needs a newer installer; download it again from https://aiboard.me.' }
    if ((ConvertTo-UtcDate $manifest.expiresAt) -le [DateTime]::UtcNow) { Fail 'the release manifest has expired; try again later.' }
    $Version = [string]$manifest.version
    if ($Version -notmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})(-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$') { Fail 'the release manifest has an invalid version.' }
    $Sequence = [long]$manifest.sequence
    if ($Sequence -lt $MinSequence) { Fail 'the release manifest is older than this installer allows (possible replay).' }
    $artifact = @($manifest.artifacts | Where-Object { $_.target -eq $Target })
    if ($artifact.Count -ne 1) { Fail "the release has no bundle for $Target." }
    $artifact = $artifact[0]
    $url = [string]$artifact.url
    if (-not $url.StartsWith($ArtifactPrefix) -or -not (Test-AllowedUrl $url)) { Fail 'the bundle is not hosted on the approved release origin.' }
    if ([string]$artifact.sha256 -notmatch '^[0-9a-f]{64}$' -or [string]$artifact.format -ne 'zip') { Fail 'the release manifest entry is invalid.' }

    # 2. Per-user lock shared with `aiboard update` / `aiboard uninstall`.
    New-Item -ItemType Directory -Force -Path $Versions | Out-Null
    $lockPath = Join-Path $Root 'install.lock'
    try { New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null }
    catch {
      $owner = Read-Pointer (Join-Path $lockPath 'pid')
      if ($owner -and (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { Fail "another AIBoard install or update is running (process $owner)." }
      Remove-Item -LiteralPath $lockPath -Recurse -Force
      New-Item -ItemType Directory -Path $lockPath | Out-Null
    }
    $Lock = $lockPath
    # A cleanup left by an earlier uninstall must never run against this new install.
    Remove-Item -LiteralPath (Join-Path $Root 'uninstall-pending.cmd') -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText((Join-Path $lockPath 'pid'), [string]$PID)

    $recorded = Read-Pointer (Join-Path $Root 'sequence')
    if ($recorded -and $Sequence -lt [long]$recorded) { Fail 'this machine already accepted a newer AIBoard release; refusing an older manifest.' }
    $current = Read-Pointer (Join-Path $Root 'current')
    $destination = Join-Path $Versions $Version
    $node = Join-Path $destination 'node\node.exe'
    $entry = Join-Path $destination 'app\runner-v2\bin\aiboard.mjs'

    if ($current -eq $Version -and (Test-Path -LiteralPath $node)) {
      Say "AI Board Runner $Version is already installed; repairing the command and PATH."
    } else {
      # 3. Bundle: size and SHA-256 must match the signed manifest before extraction.
      $archive = Join-Path $Work "aiboard-$Version-$Target.zip"
      Say "Downloading AI Board Runner $Version for $Target..."
      Get-Download $url $archive
      if ((Get-Item -LiteralPath $archive).Length -ne [long]$artifact.bytes) { Fail 'the downloaded bundle has the wrong size. Nothing was installed.' }
      if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$artifact.sha256) { Fail 'the downloaded bundle does not match the signed checksum. Nothing was installed.' }

      # 4. Extract into a fresh staging folder, refusing traversal, links and oversize content.
      $staging = Join-Path $Versions (".s-" + $PID)
      if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
      New-Item -ItemType Directory -Path $staging | Out-Null
      $stagingFull = [IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
      Add-Type -AssemblyName System.IO.Compression
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [IO.Compression.ZipFile]::OpenRead($archive)
      try {
        if ($zip.Entries.Count -gt 40000) { Fail 'the bundle has too many entries.' }
        $total = [long]0
        foreach ($item in $zip.Entries) {
          $name = $item.FullName
          if ($name -match '[\\:*?"<>|]' -or $name.StartsWith('/') -or @($name.TrimEnd('/') -split '/' | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) { Fail "unsafe path in bundle: $name" }
          if ($item.PSObject.Properties['ExternalAttributes'] -and ((($item.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000)) { Fail "the bundle contains a link: $name" }
          if ($name.EndsWith('/')) { continue }
          $total += $item.Length
          if ($item.Length -gt 536870912 -or $total -gt 1610612736) { Fail 'the bundle is larger than allowed.' }
          $outFile = [IO.Path]::GetFullPath((Join-Path $staging ($name -replace '/', '\')))
          if (-not $outFile.StartsWith($stagingFull, [StringComparison]::OrdinalIgnoreCase)) { Fail "bundle entry escapes the install folder: $name" }
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outFile) | Out-Null
          [IO.Compression.ZipFileExtensions]::ExtractToFile($item, $outFile, $false)
        }
      } finally { $zip.Dispose() }
      $release = [IO.File]::ReadAllText((Join-Path $staging 'release.json')) | ConvertFrom-Json
      if ($release.version -ne $Version -or $release.target -ne $Target) { Fail 'the bundle does not describe the release it was published as.' }

      # 5. Bounded smoke check with the bundle's own Node before switching.
      $ErrorActionPreference = 'Continue'
      $smoke = & (Join-Path $staging 'node\node.exe') (Join-Path $staging 'app\runner-v2\bin\aiboard.mjs') version 2>&1 | Out-String
      $smokeExit = $LASTEXITCODE
      $ErrorActionPreference = 'Stop'
      if ($smokeExit -ne 0 -or $smoke.Trim() -ne "AIBoard Runner V2 $Version") { Fail "the new version did not start: $($smoke.Trim())" }
      if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
      Move-Item -LiteralPath $staging -Destination $destination
    }

    # 6. Command shim, then the atomic version switch.
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    $shim = @(
      '@echo off',
      'setlocal',
      'set "AIBOARD_ROOT=%~dp0.."',
      'set "AIBOARD_VERSION="',
      'set /p AIBOARD_VERSION=<"%AIBOARD_ROOT%\current"',
      'if not defined AIBOARD_VERSION (',
      '  echo aiboard: no active version; reinstall with: irm https://aiboard.me/install.ps1 ^| iex 1>&2',
      '  exit /b 1',
      ')',
      '"%AIBOARD_ROOT%\versions\%AIBOARD_VERSION%\node\node.exe" "%AIBOARD_ROOT%\versions\%AIBOARD_VERSION%\app\runner-v2\bin\aiboard.mjs" %*',
      'if exist "%AIBOARD_ROOT%\uninstall-pending.cmd" ( (goto) 2>nul & "%AIBOARD_ROOT%\uninstall-pending.cmd" )',
      'exit /b %ERRORLEVEL%'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $Bin 'aiboard.cmd'), "$shim`r`n", (New-Object Text.ASCIIEncoding))
    $highest = $Sequence
    if ($recorded -and [long]$recorded -gt $highest) { $highest = [long]$recorded }
    Write-Pointer (Join-Path $Root 'sequence') ([string]$highest)
    if ($current -and $current -ne $Version) { Write-Pointer (Join-Path $Root 'previous') $current }
    Write-Pointer (Join-Path $Root 'current') $Version
    $marker = Join-Path $Root 'install.json'
    if (-not (Test-Path -LiteralPath $marker)) {
      [IO.File]::WriteAllText($marker, "{`"schemaVersion`":1,`"product`":`"aiboard-runner`",`"channel`":`"$Channel`",`"installer`":`"install.ps1`"}`n")
    }

    # 7. Keep the active and previous versions; older ones are removed when not in use.
    $keep = @($Version, (Read-Pointer (Join-Path $Root 'previous')))
    Get-ChildItem -LiteralPath $Versions -Directory | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    # 8. User PATH (HKCU only), unexpanded and with its registry value kind preserved.
    if ($env:AIBOARD_NO_MODIFY_PATH -ne '1') {
      $norm = { param($p) ([Environment]::ExpandEnvironmentVariables($p)).TrimEnd('\').ToLowerInvariant() }
      $registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      try {
        $old = [string]$registry.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = @($old -split ';' | Where-Object { $_ -ne '' })
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($registry.GetValueNames() -contains 'Path') { $kind = $registry.GetValueKind('Path') }
        if (@($parts | Where-Object { (& $norm $_) -eq (& $norm $Bin) }).Count -eq 0) {
          $registry.SetValue('Path', ((@($parts) + $Bin) -join ';'), $kind)
          [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', '1', 'User')
          [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', $null, 'User')
        }
      } finally { $registry.Close() }
      if (@($env:Path -split ';' | Where-Object { $_ -and (& $norm $_) -eq (& $norm $Bin) }).Count -eq 0) { $env:Path = "$env:Path;$Bin" }
      $found = Get-Command aiboard -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found -and $found.Source -and (& $norm (Split-Path -Parent $found.Source)) -ne (& $norm $Bin)) { Say "Warning: another aiboard ($($found.Source)) comes first on PATH." }
    }

    Say ''
    Say "AI Board Runner $Version is installed in $Root."
    Say 'Start it in a project folder:  aiboard'
    Say 'Let ChatGPT or Claude use this computer:  aiboard remote'
    Say 'Open a new terminal if the aiboard command is not found yet. Update: aiboard update. Remove: aiboard uninstall.'
  } finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    if ($Lock) { Remove-Item -LiteralPath $Lock -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
