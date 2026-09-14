$ErrorActionPreference='Stop'
Set-Location 'D:\repos\ai-discussion-board\.worktrees\runner-v2-robust-build'
$c='.superpowers\sdd\2026-09-11-p6-completion\task9-git-hardening\causal-controller.mjs'
$cases=@(
  @('causal-final-hook-red','pre-commit hook','hook-sentinel.txt','hook','"core.hooksPath=", ',''),
  @('causal-final-clean-red','repository clean filter','clean-sentinel.txt','clean','section === "filter"','section === "filter-disabled"','lower.startsWith("filter=")','lower.startsWith("filter-disabled=")'),
  @('causal-final-fsmonitor-red','neutralizes repository fsmonitor helpers','fsmonitor-sentinel.txt','fsmonitor','"core.fsmonitor=false", ',''),
  @('causal-final-ssh-red','repository SSH command overrides','ssh-sentinel.txt','ssh','"sshcommand", ',''),
  @('causal-final-credential-red','repository credential helpers','credential-sentinel.txt','credential','"credential.helper=", ','','section === "credential"','section === "credential-disabled"'),
  @('causal-final-external-diff-red','repository external diff before diff can launch it','external-diff-sentinel.txt','diff','["command", "textconv", "external"]','["command", "textconv"]')
)
foreach($case in $cases){
  Write-Host "=== $($case[0]) ==="
  $encoded=$case | ForEach-Object { 'b64:'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) }
  & node $c @encoded
  if($LASTEXITCODE -ne 0){ throw "causal case $($case[0]) failed: $LASTEXITCODE" }
}
$hash=(Get-FileHash 'runner-v2\src\git-execution-policy.ts' -Algorithm SHA256).Hash.ToLower()
Write-Host "FINAL_POLICY_SHA=$hash"
