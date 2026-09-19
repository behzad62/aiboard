param([Parameter(Mandatory=$true)][string]$ReceiptId)
$ErrorActionPreference='Stop'
if($ReceiptId -notmatch '^[a-z0-9_-]+$'){throw 'A unique audit receipt ID is required'}
$base=Join-Path (Get-Location) '.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence'
$audit=Get-Content -LiteralPath (Join-Path $base 'acceptance-audit.json') -Raw | ConvertFrom-Json
$receipts=@(Get-ChildItem -LiteralPath $base -Filter terminal.json -Recurse -File | ForEach-Object {Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json})
$all=@(Get-CimInstance Win32_Process)
$direct=@()
foreach($receipt in $receipts){
  if(!$receipt.startedAt -or !$receipt.finishedAt){continue}
  $start=([datetime]$receipt.startedAt).ToUniversalTime().AddSeconds(-2)
  $end=([datetime]$receipt.finishedAt).ToUniversalTime().AddSeconds(2)
  foreach($id in @($receipt.wrapperPid,$receipt.testPid,$receipt.childPid) | Where-Object {$_}){
    $live=$all | Where-Object {$_.ProcessId -eq $id -and $_.ProcessId -ne $PID}
    if($live -and $live.CreationDate.ToUniversalTime() -ge $start -and $live.CreationDate.ToUniversalTime() -le $end){$direct += $live}
  }
}
$owned=@($direct | Select-Object -ExpandProperty ProcessId -Unique)
do {
  $next=@($all | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned -and $_.ProcessId -ne $PID})
  $owned += @($next | Select-Object -ExpandProperty ProcessId)
} while($next.Count -gt 0)
$roots=@($audit.runs | ForEach-Object {$_.roots} | ForEach-Object {$_.path})
$roots+=@($audit.history | ForEach-Object {$_.retainedAtReceipt} | ForEach-Object {$_.path})
$roots=@($roots | Select-Object -Unique)
$referencing=@($all | Where-Object {
  if($_.ProcessId -eq $PID -or !$_.CommandLine){return $false}
  $command=$_.CommandLine -replace '\\+','\'
  foreach($root in $roots){if($command.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $true}}
  return $false
})
$wrappers=@($all | Where-Object {$_.ProcessId -ne $PID -and $_.Name -eq 'node.exe' -and $_.CommandLine -match 'task10-filesystem-fence[\\/].*(gate|review[^\\/]*|reverse-fault)\.mjs'})
$projected=@($all | Where-Object {$_.ProcessId -in $owned} | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
$result=[ordered]@{time=(Get-Date).ToUniversalTime().ToString('o');receiptCount=$receipts.Count;rootCount=$roots.Count;
  birthMatchedOwnedProcesses=$projected;rootReferencingProcesses=@($referencing | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine);
  liveTestReviewWrappers=@($wrappers | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine);
  clean=($projected.Count -eq 0 -and $referencing.Count -eq 0 -and $wrappers.Count -eq 0);
  note='Read-only process and command-path observation, combined with fresh fixture-owned shutdown assertions. Reused PIDs outside recorded birth intervals are not treated as owned. No process is killed by this audit.'}
$destination=Join-Path $base ($ReceiptId+'.json')
if(Test-Path -LiteralPath $destination){throw 'Refusing to overwrite audit evidence'}
[IO.File]::WriteAllText($destination,($result | ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 8
if(!$result.clean){exit 1}
