param([Parameter(Mandatory=$true)][string]$ReceiptId)
$ErrorActionPreference='Stop'
if($ReceiptId -notmatch '^[a-z0-9_-]+$'){throw 'Unique receipt ID required'}
$base=Join-Path (Get-Location) '.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence'
$audit=Get-Content -LiteralPath (Join-Path $base 'finish-acceptance-audit.json') -Raw | ConvertFrom-Json
$all=@(Get-CimInstance Win32_Process)
$matches=@(); $identities=0
foreach($file in Get-ChildItem -LiteralPath $base -Recurse -File | Where-Object {$_.Name -in @('wrapper.json','child.json')}){
  $r=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
  if(!$r.identity.StartTimeUtc -or !$r.identity.Id){continue}
  $identities++
  $birth=([datetime]$r.identity.StartTimeUtc).ToUniversalTime()
  $matches+=@($all | Where-Object {$_.ProcessId -eq $r.identity.Id -and $_.ProcessId -ne $PID -and
    [Math]::Abs(($_.CreationDate.ToUniversalTime()-$birth).TotalMilliseconds) -le 50})
}
$owned=@($matches | Select-Object -ExpandProperty ProcessId -Unique)
do{
  $children=@($all | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned -and $_.ProcessId -ne $PID})
  $owned+=@($children | Select-Object -ExpandProperty ProcessId)
}while($children.Count -gt 0)
$roots=@($audit.runs | ForEach-Object {$_.roots} | ForEach-Object {$_.path})
$roots+=@($audit.history | ForEach-Object {$_.retainedAtReceipt} | ForEach-Object {$_.path})
$roots=@($roots | Select-Object -Unique)
$referencing=@($all | Where-Object {
  if($_.ProcessId -eq $PID -or !$_.CommandLine){return $false}
  $command=$_.CommandLine -replace '\\+','\'
  foreach($root in $roots){if($command.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $true}}
  return $false
})
$wrappers=@($all | Where-Object {$_.ProcessId -ne $PID -and $_.Name -eq 'node.exe' -and
  $_.CommandLine -match 'task10-filesystem-fence[\\/].*(gate|review[^\\/]*|reverse-fault)\.mjs'})
$projected=@($all | Where-Object {$_.ProcessId -in $owned} | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
$result=[ordered]@{time=(Get-Date).ToUniversalTime().ToString('o');recordedBirthIdentities=$identities;rootCount=$roots.Count;
  birthMatchedOwnedProcesses=$projected;rootReferencingProcesses=@($referencing | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine);
  liveTestReviewWrappers=@($wrappers | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine);
  clean=($projected.Count -eq 0 -and $referencing.Count -eq 0 -and $wrappers.Count -eq 0);
  note='Read-only audit of exact recorded process births, descendants and exact fixture-root command references. Recycled PIDs are not ownership. This supplements the GREEN fixtures own release/shutdown assertions. No processes or roots are removed.'}
$destination=Join-Path $base ($ReceiptId+'.json')
if(Test-Path -LiteralPath $destination){throw 'Refusing to overwrite evidence'}
[IO.File]::WriteAllText($destination,($result|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
$result|ConvertTo-Json -Depth 8
if(!$result.clean){exit 1}
