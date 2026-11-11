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
  $Epoch = __AIBOARD_EPOCH__
  $AnchorDigest = '__AIBOARD_ANCHOR_DIGEST__'
  $TrustConfig = '__AIBOARD_TRUST_CONFIG__'
  $MinSequence = __AIBOARD_MIN_SEQUENCE__
  $AllowLoopback = __AIBOARD_ALLOW_LOOPBACK_PS__
  $TrustedKeys = @(
__AIBOARD_TRUSTED_KEYS_PS__
  )
  $RecoveryKeys = @(
__AIBOARD_RECOVERY_KEYS_PS__
  )
  $InstallerProtocol = 2
  # GitHub's site and REST API, for the bundle download fallback in Get-Bundle.
  $GithubWeb = 'https://github.com'
  $GithubApi = 'https://api.github.com'

  function Fail([string]$Message) { throw "AIBoard install failed: $Message" }
  # Color only in an interactive console; NO_COLOR turns it off and FORCE_COLOR decides when set (0/false: off).
  $UseColor = if ($env:FORCE_COLOR) { @('0', 'false') -notcontains $env:FORCE_COLOR } else { -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected }
  function Say([string]$Message, [string]$Color = '') { if ($Color -and $UseColor) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message } }
  function Get-GitHint {
    if (Get-Command git -CommandType Application -ErrorAction SilentlyContinue) { return '' }
    'Install Git for Windows from https://git-scm.com/download/win, then open a new terminal'
  }

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

  # Redirects are followed by hand (at most 5) and every hop is checked before it is contacted, so an
  # HTTPS download can never be redirected to plain HTTP (Windows PowerShell's automatic redirects allow that).
  # $Accept is sent on every hop. With -Report a failed download returns why instead of stopping the install:
  # Reason, Message, and Transient for an HTTP 5xx answer, a timeout or a network error, which another route
  # may avoid. An unsafe redirect always stops the install.
  function Get-Download([string]$Url, [string]$Path, [string]$Accept = '', [switch]$Report) {
    $next = $Url
    for ($hop = 0; ; $hop++) {
      if (-not (Test-AllowedUrl $next)) { Fail "refusing a non-HTTPS download or redirect: $next" }
      if ($hop -gt 5) { Fail "too many redirects downloading $Url." }
      $request = [Net.HttpWebRequest]::Create($next)
      $request.AllowAutoRedirect = $false
      $request.Timeout = 600000
      $request.ReadWriteTimeout = 600000
      $request.UserAgent = 'AIBoard-Installer'
      if ($Accept) { $request.Accept = $Accept }
      $response = $null
      $reason = $null
      $transient = $true
      try { $response = $request.GetResponse() }
      catch [Net.WebException] { $response = $_.Exception.Response; if (-not $response) { $reason = [string]$_.Exception.Message } }
      catch { $reason = [string]$_.Exception.Message }
      if ($response) {
        try {
          $status = [int]$response.StatusCode
          if ($status -ge 300 -and $status -lt 400) {
            $location = $response.Headers['Location']
            if (-not $location) { Fail "could not download $Url (redirect without a location)." }
            $next = (New-Object Uri((New-Object Uri($next)), $location)).AbsoluteUri
            continue
          }
          if ($status -ne 200) { $reason = "HTTP $status"; $transient = $status -ge 500 }
          else {
            $stream = $response.GetResponseStream()
            $file = [IO.File]::Create($Path)
            try { $stream.CopyTo($file) } catch { $reason = [string]$_.Exception.Message }
            finally { $file.Dispose(); $stream.Dispose() }
            if ($null -eq $reason) { return }
          }
        } finally { $response.Dispose() }
      }
      $message = "could not download $Url ($reason). Check your connection and retry; nothing was changed."
      if (-not $Report) { Fail $message }
      return (New-Object PSObject -Property @{ Reason = $reason; Message = $message; Transient = $transient })
    }
  }

  # GitHub's releases/download links have answered 504 for many minutes while the same asset kept working
  # through its REST API. A bundle on such a link that fails with an HTTP 5xx, a timeout or a network error is
  # fetched once more through the API, without a token: the release by tag gives the asset id, then the asset
  # itself. Only the numeric id comes from GitHub's answer; the caller checks the bundle against the signed
  # manifest either way. When both routes fail, the link's own error is reported.
  function Get-Bundle([string]$Url, [string]$Path) {
    $failure = Get-Download $Url $Path -Report
    if (-not $failure) { return }
    $prefix = "$GithubWeb/"
    $route = $null
    if ($failure.Transient -and $Url.StartsWith($prefix, [StringComparison]::Ordinal) -and
        $Url.Substring($prefix.Length) -cmatch '^([A-Za-z0-9-]+/[A-Za-z0-9._-]+)/releases/download/([^/]+)/([^/]+)$') { $route = $Matches }
    if (-not $route) { Fail $failure.Message }
    Say "The GitHub download link failed ($($failure.Reason)); trying the GitHub API..."
    $api = "$GithubApi/repos/$($route[1])"
    $name = [Uri]::UnescapeDataString($route[3])
    $listing = "$Path.release.json"
    $problem = Get-Download "$api/releases/tags/$($route[2])" $listing 'application/vnd.github+json' -Report
    if (-not $problem) {
      $id = $null
      try {
        if ((Get-Item -LiteralPath $listing).Length -le 1048576) {
          $hits = @(([IO.File]::ReadAllText($listing) | ConvertFrom-Json).assets | Where-Object { $_.name -ceq $name })
          if ($hits.Count -eq 1 -and ($hits[0].id -is [int] -or $hits[0].id -is [long]) -and $hits[0].id -ge 1) { $id = [long]$hits[0].id }
        }
      } catch { }
      if ($id) { $problem = Get-Download "$api/releases/assets/$id" $Path 'application/octet-stream' -Report }
      else { $problem = New-Object PSObject -Property @{ Reason = "GitHub's API did not list $name in release $([Uri]::UnescapeDataString($route[2]))" } }
    }
    if ($problem) {
      Say "The GitHub API failed too ($($problem.Reason))."
      Fail $failure.Message
    }
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

  function Test-RecordedSequence([string]$Root, [long]$manifestEpoch, [long]$Sequence, [string]$AnchorDigest) {
    $recorded = Read-Pointer (Join-Path $Root 'sequence')
    $recordedAnchor = Read-Pointer (Join-Path $Root 'sequence-anchor')
    if ((Test-Path -LiteralPath (Join-Path $Root 'sequence-anchor')) -and -not $recordedAnchor) { Fail 'the stored release trust anchor is corrupt.' }
    if ($recordedAnchor) {
      if ($recordedAnchor -notmatch '^[0-9a-f]{64}$') { Fail 'the stored release trust anchor is corrupt.' }
      if ($recordedAnchor -ne $AnchorDigest) { $recorded = $null }
    } else { $recorded = $null }
    if ((Test-Path -LiteralPath (Join-Path $Root 'sequence')) -and -not $recorded -and $recordedAnchor -eq $AnchorDigest) { Fail 'the stored release sequence is corrupt.' }
    if ($recorded) {
      if ($recorded -notmatch '^(?:(0|[1-9][0-9]*):)?([1-9][0-9]*)$') { Fail 'the stored release sequence is corrupt.' }
      $recordedEpoch = if ($Matches[1]) { [long]$Matches[1] } else { [long]0 }
      $recordedSequence = [long]$Matches[2]
      if ($recordedEpoch -gt 1048576 -or $recordedSequence -gt 1099511627776) { Fail 'the stored release sequence is corrupt.' }
      if ($manifestEpoch -lt $recordedEpoch -or ($manifestEpoch -eq $recordedEpoch -and $Sequence -lt $recordedSequence)) { Fail 'this machine already accepted a newer AIBoard release; refusing an older manifest.' }
    }
  }

  # Runs one staged-bundle command for at most $Seconds. A command that outlives the bound is killed and must
  # be seen to exit; if it cannot be, $State.Unsettled keeps the install lock and staging in place, so nothing
  # is released or deleted while it may still run.
  $State = @{ Unsettled = $false }
  function Invoke-Bounded([string]$File, [string[]]$Arguments, [int]$Seconds, [string]$What) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.Arguments = (@($Arguments | ForEach-Object { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::Start($info)
    try {
      $stdout = $process.StandardOutput.ReadToEndAsync()
      $stderr = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit($Seconds * 1000)) {
        try { $process.Kill() } catch { }
        if (-not $process.WaitForExit(15000)) {
          $State.Unsettled = $true
          Fail "$What did not finish within $Seconds seconds and could not be stopped (process $($process.Id)). The install lock and staging folder were kept; end that process, then remove them and retry."
        }
        Fail "$What did not finish within $Seconds seconds. Nothing was installed."
      }
      $process.WaitForExit()
      return New-Object PSObject -Property @{ ExitCode = $process.ExitCode; Output = ($stdout.Result + $stderr.Result).Trim() }
    } finally { $process.Dispose() }
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
  $LockOwner = $null
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
    $signerRole = $null
    foreach ($set in @(@{ Role = 'ordinary'; Items = $TrustedKeys }, @{ Role = 'recovery'; Items = $RecoveryKeys })) {
      foreach ($key in $set.Items) {
        $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
        try {
          $parameters = New-Object Security.Cryptography.RSAParameters
          $parameters.Modulus = [Convert]::FromBase64String($key.Modulus)
          $parameters.Exponent = [Convert]::FromBase64String($key.Exponent)
          $rsa.ImportParameters($parameters)
          if ($rsa.VerifyData($manifestBytes, 'SHA256', $signature)) { $signer = $key.Id; $signerRole = $set.Role; break }
        } finally { $rsa.Dispose() }
      }
      if ($signer) { break }
    }
    if (-not $signer) { Fail 'the release manifest signature does not verify against the trusted AIBoard release key. Nothing was installed.' }
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -and $manifest.schemaVersion -ne 2) { Fail 'unsupported release manifest version.' }
    if ($manifest.product -ne 'aiboard-runner' -or $manifest.channel -ne $Channel) { Fail 'the release manifest is for another product or channel.' }
    $manifestEpoch = if ($manifest.schemaVersion -eq 1) { [long]0 } else { [long]$manifest.epoch }
    if ($manifestEpoch -lt 0 -or $manifestEpoch -gt 1048576 -or $manifestEpoch -lt $Epoch) { Fail 'the release manifest has an invalid or older epoch.' }
    if ($manifestEpoch -gt $Epoch) {
      if ($signerRole -ne 'recovery' -or @($manifest.signingKeys).Count -eq 0) { Fail 'a new epoch requires a recovery signature and new signing keys.' }
    } elseif ($signerRole -ne 'ordinary') { Fail 'a recovery key cannot sign an ordinary release.' }
    if ($manifest.keyId -ne $signer) { Fail 'the release manifest names a different key than the one that signed it.' }
    if ([int]$manifest.minInstallerVersion -gt $InstallerProtocol) { Fail 'this release needs a newer installer; download it again from https://aiboard.me.' }
    if ((ConvertTo-UtcDate $manifest.expiresAt) -le [DateTime]::UtcNow) { Fail 'the release manifest has expired; try again later.' }
    $Version = [string]$manifest.version
    if ($Version -notmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})(-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$') { Fail 'the release manifest has an invalid version.' }
    $Sequence = [long]$manifest.sequence
    if ($Sequence -lt 1 -or $Sequence -gt 1099511627776) { Fail 'the release manifest has an invalid sequence.' }
    if ($manifestEpoch -eq $Epoch -and $Sequence -lt $MinSequence) { Fail 'the release manifest is older than this installer allows (possible replay).' }
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
    catch { if (Test-Path -LiteralPath $lockPath) { Fail "the install lock exists. After confirming no install, update, or uninstall is running, delete $lockPath and retry." }; throw }
    $pendingOwner = Join-Path $lockPath ('owner-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($pendingOwner, [string]$PID)
    $Lock = $lockPath
    $LockOwner = $pendingOwner
    # A cleanup left by an earlier uninstall must never run against this new install.
    Remove-Item -LiteralPath (Join-Path $Root 'uninstall-pending.cmd') -Force -ErrorAction SilentlyContinue

    Test-RecordedSequence $Root $manifestEpoch $Sequence $AnchorDigest
    $current = Read-Pointer (Join-Path $Root 'current')
    $destination = Join-Path $Versions $Version
    $node = Join-Path $destination 'node\node.exe'
    $entry = Join-Path $destination 'app\runner-v2\bin\aiboard.mjs'

    $inventoryScript = @'
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const [verified, dir, version, target] = process.argv.slice(2);
if (!readFileSync(resolve(verified, 'release.json')).equals(readFileSync(resolve(dir, 'release.json')))) throw new Error('release inventory differs from signed bundle');
import(pathToFileURL(resolve(verified, 'app/runner-v2/src/self-update.js')).href)
  .then(m => m.verifyVersionDirectory(dir, { version, target }))
  .catch(e => { console.error(e.message); process.exitCode = 1; });
'@
    $inventoryPath = Join-Path $Work 'verify-inventory.cjs'
    [IO.File]::WriteAllText($inventoryPath, $inventoryScript, (New-Object Text.UTF8Encoding($false)))

      # 3. Bundle: size and SHA-256 must match the signed manifest before extraction.
      $archive = Join-Path $Work "aiboard-$Version-$Target.zip"
      Say "Downloading AI Board Runner $Version for $Target..."
      Get-Bundle $url $archive
      if ((Get-Item -LiteralPath $archive).Length -ne [long]$artifact.bytes) { Fail 'the downloaded bundle has the wrong size. Nothing was installed.' }
      $sha256 = [Security.Cryptography.SHA256]::Create()
      $stream = [IO.File]::OpenRead($archive)
      try { $digest = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
      finally { $stream.Dispose(); $sha256.Dispose() }
      if ($digest -ne [string]$artifact.sha256) { Fail 'the downloaded bundle does not match the signed checksum. Nothing was installed.' }

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

      # The archive's signed checksum authenticates the bundled Node and verifier before they run.
      $stagedNode = Join-Path $staging 'node\node.exe'
      $inventory = Invoke-Bounded $stagedNode @($inventoryPath, $staging, $staging, $Version, $Target) 600 'Bundle inventory verification'
      if ($inventory.ExitCode -ne 0) { Fail "bundle inventory verification failed. Nothing was installed. $($inventory.Output)" }

      $trustConfigPath = Join-Path $Work 'trust-config.json'
      $nextTrustPath = Join-Path $Work 'next-trust.json'
      $nextAnchorPath = Join-Path $Work 'next-anchor'
      [IO.File]::WriteAllText($trustConfigPath, $TrustConfig, (New-Object Text.UTF8Encoding($false)))
      [IO.File]::WriteAllText($nextTrustPath, $TrustConfig, (New-Object Text.UTF8Encoding($false)))
      [IO.File]::WriteAllText($nextAnchorPath, $AnchorDigest, (New-Object Text.UTF8Encoding($false)))
      if ($manifest.schemaVersion -eq 2) {
        $trustScript = @'
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const [dir, manifest, signature, configPath, out, anchor] = process.argv.slice(2);
import(pathToFileURL(resolve(dir, 'app/runner-v2/src/release-manifest.js')).href).then(m => {
  const config = m.parseReleaseChannelConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const release = m.verifyReleaseManifest(readFileSync(manifest), readFileSync(signature, 'utf8'), config, { now: new Date() });
  const next = release.epoch > config.epoch ? m.parseReleaseChannelConfig({ ...config, epoch: release.epoch, keys: release.signingKeys, minSequence: 1 }) : config;
  writeFileSync(out, JSON.stringify(next), { mode: 0o600 });
  writeFileSync(anchor, m.releaseAnchorDigest(next), { mode: 0o600 });
}).catch(e => { console.error(e.message); process.exitCode = 1; });
'@
        $trustPath = Join-Path $Work 'verify-trust.cjs'
        [IO.File]::WriteAllText($trustPath, $trustScript, (New-Object Text.UTF8Encoding($false)))
        $trust = Invoke-Bounded $stagedNode @($trustPath, $staging, $manifestPath, "$manifestPath.sig", $trustConfigPath, $nextTrustPath, $nextAnchorPath) 120 'Release trust verification'
        if ($trust.ExitCode -ne 0) { Fail "release trust verification failed. Nothing was installed. $($trust.Output)" }
      }

      # 5. Bounded smoke check with the bundle's own Node before switching.
      $smoke = Invoke-Bounded $stagedNode @((Join-Path $staging 'app\runner-v2\bin\aiboard.mjs'), 'version') 120 'The new version'
      if ($smoke.ExitCode -ne 0 -or $smoke.Output -ne "AIBoard Runner V2 $Version") { Fail "the new version did not start: $($smoke.Output)" }
      if ($current -eq $Version -and (Test-Path -LiteralPath $destination)) {
        $inventory = Invoke-Bounded $stagedNode @($inventoryPath, $staging, $destination, $Version, $Target) 600 'The existing version''s inventory check'
        if ($inventory.ExitCode -ne 0) { Fail "the existing version failed its inventory check. After stopping all AIBoard processes, remove $destination and run the installer again. $($inventory.Output)" }
        Say "AI Board Runner $Version is already installed; repairing the command and PATH."
      } else {
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Move-Item -LiteralPath $staging -Destination $destination
        $staging = $null
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
    Write-Pointer (Join-Path $Root 'trusted-channel.json') ([IO.File]::ReadAllText($nextTrustPath))
    Write-Pointer (Join-Path $Root 'sequence') ("${manifestEpoch}:${Sequence}")
    Write-Pointer (Join-Path $Root 'sequence-anchor') ([IO.File]::ReadAllText($nextAnchorPath))
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
        $pathExisted = $registry.GetValueNames() -contains 'Path'
        if ($pathExisted) { $kind = $registry.GetValueKind('Path') }
        if (@($parts | Where-Object { (& $norm $_) -eq (& $norm $Bin) }).Count -eq 0) {
          if (-not $pathExisted) { [IO.File]::WriteAllText((Join-Path $Root 'path-was-absent'), '') }
          $newPath = if ($old) { "$old;$Bin" } else { $Bin }
          $registry.SetValue('Path', $newPath, $kind)
          [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', '1', 'User')
          [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', $null, 'User')
        }
      } finally { $registry.Close() }
      if (@($env:Path -split ';' | Where-Object { $_ -and (& $norm $_) -eq (& $norm $Bin) }).Count -eq 0) { $env:Path = "$env:Path;$Bin" }
      $found = Get-Command aiboard -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found -and $found.Source -and (& $norm (Split-Path -Parent $found.Source)) -ne (& $norm $Bin)) { Say "Warning: another aiboard ($($found.Source)) comes first on PATH." }
    }

    Say ''
    Say "AI Board Runner $Version is installed in $Root." 'Green'
    Say 'Start it in a project folder:  aiboard'
    Say 'Let ChatGPT or Claude use this computer:  aiboard remote'
    Say 'Open a new terminal if the aiboard command is not found yet. Update: aiboard update. Remove: aiboard uninstall.'
    $gitHint = Get-GitHint
    if ($gitHint) {
      Say ''
      Say "Note: Git was not found. Chat and account providers work without it; Build mode needs Git. $gitHint." 'Yellow'
    }
  } finally {
    if ($State.Unsettled) {
      # A staged process may still be running: keep everything it could be using, and the lock that guards it.
      Write-Warning "Kept the install lock $Lock, the staging folder $staging and $Work because a staged process may still be running."
      $Lock = $null; $staging = $null; $Work = $null
    }
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    if ($Lock) {
      try {
        if (-not (Test-Path -LiteralPath $LockOwner) -or [IO.File]::ReadAllText($LockOwner) -ne [string]$PID) { throw 'owner marker is missing or changed' }
        [IO.File]::Delete($LockOwner)
        [IO.Directory]::Delete($Lock)
      } catch { Write-Warning "Could not release install lock $Lock. Confirm no install, update, or uninstall is running before removing it." }
    }
    if ($Work) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
