/**
 * The PowerShell that keeps a shell session's state between commands. The Runner hands it to the shell in
 * $env:AIBOARD_SESSION_HOST (sessionHostCommand), so it is plain script text, never a file or a binary. It works the same in Windows PowerShell 5.1 and PowerShell 7.
 *
 * One runspace lives for the whole session, and every command runs dot-sourced at its global scope: variables,
 * functions, $env: values, the current location and imported modules carry over to the next command.
 *
 * Protocol, one line per command on stdin: base64 of UTF-8 JSON {id, script, timeoutMs, cwd?}. The first command
 * arrives in $env:AIBOARD_SESSION_FIRST instead, because the call that launches the session cannot also write to it.
 * Each command's output is fenced on stdout and on stderr by lines that only this session can print, since they carry
 * its random nonce:
 *   <<aiboard:NONCE:ID:start>>
 *   ... the command's output ...
 *   <<aiboard:NONCE:ID:end>>{"exitCode":0,"timedOut":false,"cwd":"..."}   (stdout; stderr's end line has no JSON)
 * A command still running at its timeoutMs is stopped like Ctrl+C, and the session keeps its state.
 */
export const SESSION_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$stdout = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$stdout.AutoFlush = $true; $stdout.NewLine = [string][char]10
$stderr = New-Object System.IO.StreamWriter ([Console]::OpenStandardError()), $utf8
$stderr.AutoFlush = $true; $stderr.NewLine = [string][char]10
$ProgressPreference = 'SilentlyContinue'
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$nonce = $env:AIBOARD_SESSION_NONCE
$first = $env:AIBOARD_SESSION_FIRST
Remove-Item Env:AIBOARD_SESSION_NONCE, Env:AIBOARD_SESSION_FIRST, Env:AIBOARD_SESSION_HOST -ErrorAction SilentlyContinue
$runspace = [runspacefactory]::CreateRunspace([System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault())
$runspace.Open()
$runspace.SessionStateProxy.SetVariable('ProgressPreference', 'SilentlyContinue')

function Write-Records($records, $writer) {
  foreach ($record in $records) {
    if ($record -is [System.Management.Automation.ErrorRecord]) {
      if ($record.FullyQualifiedErrorId -like 'NativeCommandError*') { $writer.WriteLine($record.Exception.Message); continue }
      $script:failed = $true
      $writer.WriteLine($record.ToString())
      $line = $record.InvocationInfo.ScriptLineNumber
      if ($line -gt 0) { $writer.WriteLine("At line:$line char:$($record.InvocationInfo.OffsetInLine)") }
    } elseif ($record -is [System.Management.Automation.InformationRecord]) { $writer.WriteLine([string]$record.MessageData) }
    elseif ($record -is [System.Management.Automation.WarningRecord]) { $writer.WriteLine("WARNING: $($record.Message)") }
    else { $writer.WriteLine(([string]$record).TrimEnd()) }
  }
}

# In a runspace without a console host, exit only asks the host to quit, so the command's exit code would be lost. Each
# exit statement becomes a throw the session catches; the session itself stays, with its state.
function Convert-Exits([string]$text) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { return $text }
  $exits = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.ExitStatementAst] }, $true)) | Sort-Object { $_.Extent.StartOffset } -Descending
  foreach ($exit in $exits) {
    $value = if ($exit.Pipeline) { $exit.Pipeline.Extent.Text } else { '0' }
    $text = $text.Substring(0, $exit.Extent.StartOffset) + '$global:__aiboardExit = (' + $value + "); throw '__aiboard_exit__'" + $text.Substring($exit.Extent.EndOffset)
  }
  $text
}

function Invoke-SessionCommand($request) {
  $id = [string]$request.id
  $stdout.WriteLine("<<aiboard:${'$'}{nonce}:${'$'}{id}:start>>"); $stderr.WriteLine("<<aiboard:${'$'}{nonce}:${'$'}{id}:start>>")
  $script:failed = $false; $timedOut = $false; $exitCode = $null
  $ps = [powershell]::Create(); $ps.Runspace = $runspace
  try {
    if ($request.env) { foreach ($entry in $request.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value) } }
    if ($request.cwd) { $runspace.SessionStateProxy.Path.SetLocation([System.Management.Automation.WildcardPattern]::Escape([string]$request.cwd)) | Out-Null }
    $runspace.SessionStateProxy.SetVariable('LASTEXITCODE', 0)
    $runspace.SessionStateProxy.SetVariable('__aiboardCommand', (Convert-Exits ([string]$request.script)))
    [void]$ps.AddScript('. ([scriptblock]::Create($__aiboardCommand))', $false).AddCommand('Out-String').AddParameter('Stream').AddParameter('Width', 200)
    $inputData = New-Object 'System.Management.Automation.PSDataCollection[psobject]'; $inputData.Complete()
    $output = New-Object 'System.Management.Automation.PSDataCollection[psobject]'
    $async = $ps.BeginInvoke($inputData, $output)
    $deadline = [DateTime]::UtcNow.AddMilliseconds([double]$request.timeoutMs)
    while (-not $async.IsCompleted) {
      Write-Records $output.ReadAll() $stdout; Write-Records $ps.Streams.Information.ReadAll() $stdout
      Write-Records $ps.Streams.Warning.ReadAll() $stdout; Write-Records $ps.Streams.Error.ReadAll() $stderr
      if (-not $timedOut -and [DateTime]::UtcNow -ge $deadline) { $timedOut = $true; [void]$ps.BeginStop($null, $null) }
      [void]$async.AsyncWaitHandle.WaitOne(25)
    }
    try { [void]$ps.EndInvoke($async) }
    catch [System.Management.Automation.PipelineStoppedException] { }
    catch {
      $inner = $_.Exception; while ($inner.InnerException -and $inner -is [System.Management.Automation.MethodInvocationException]) { $inner = $inner.InnerException }
      if ($inner.Message -eq '__aiboard_exit__') {
        $value = $runspace.SessionStateProxy.GetVariable('__aiboardExit')
        $exitCode = if ($value -is [int]) { $value } elseif ("$value" -match '^-?\d+$') { [int]"$value" } else { 0 }
      }
      elseif ($inner -isnot [System.Management.Automation.PipelineStoppedException]) { $script:failed = $true; $stderr.WriteLine($inner.Message) }
    }
    Write-Records $output.ReadAll() $stdout; Write-Records $ps.Streams.Information.ReadAll() $stdout
    Write-Records $ps.Streams.Warning.ReadAll() $stdout; Write-Records $ps.Streams.Error.ReadAll() $stderr
    if ($null -eq $exitCode -and -not $timedOut) {
      $last = $runspace.SessionStateProxy.GetVariable('LASTEXITCODE')
      $exitCode = if ($last -is [int] -and $last -ne 0) { $last } elseif ($script:failed) { 1 } else { 0 }
    }
  } catch { $stderr.WriteLine($_.Exception.Message); if ($null -eq $exitCode) { $exitCode = 1 } }
  finally { $ps.Dispose() }
  $cwd = $runspace.SessionStateProxy.Path.CurrentFileSystemLocation.ProviderPath
  $result = @{ exitCode = $exitCode; timedOut = $timedOut; cwd = $cwd } | ConvertTo-Json -Compress
  $stderr.WriteLine(""); $stderr.WriteLine("<<aiboard:${'$'}{nonce}:${'$'}{id}:end>>")
  $stdout.WriteLine(""); $stdout.WriteLine("<<aiboard:${'$'}{nonce}:${'$'}{id}:end>>$result")
}

function Read-Request($text) { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text)) | ConvertFrom-Json }

if ($first) { Invoke-SessionCommand (Read-Request $first) }
while ($null -ne ($line = $stdin.ReadLine())) {
  if ($line.Trim()) { Invoke-SessionCommand (Read-Request $line.Trim()) }
}
`;

/**
 * What -Command runs: the host script, from the environment. The command line stays short, so it also fits through
 * cmd.exe, which a Store app's pwsh needs (shell-session.ts).
 */
export const SESSION_HOST_COMMAND = "& ([scriptblock]::Create($env:AIBOARD_SESSION_HOST))";
