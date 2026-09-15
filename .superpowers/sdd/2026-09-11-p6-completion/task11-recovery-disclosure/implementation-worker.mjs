import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const base = '.superpowers/sdd/2026-09-11-p6-completion/task11-recovery-disclosure';
const dir = base + '/implementation-1'; fs.mkdirSync(dir);
const brief = fs.readFileSync(base + '/worker-brief.md', 'utf8');
const startedAt = new Date().toISOString();
const args = ['--print', '--safe-mode', '--strict-mcp-config', '--tools', 'Read,Edit,Write,Grep,Glob,Bash',
  '--allowedTools', 'Read,Edit,Write,Grep,Glob,Bash', '--disallowedTools', 'Bash(git push*),Bash(git clean*),Bash(git reset*),Bash(git commit*),Bash(git add*)',
  '--no-session-persistence', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
  '--model', 'opus', '--effort', 'high', '--max-budget-usd', '8', '--verbose', '--output-format', 'stream-json',
  '--system-prompt', 'You are the sole implementation worker for an approved local software task. Follow the supplied brief and original Task 11 specification. Preserve unrelated work. Do not stage, commit, push, create agents, make product model calls or ask questions. Keep a durable progress ledger. The controller independently reviews your actual diff and tests.'];
const child = spawn('C:\\Users\\b_a_s\\.local\\bin\\claude.exe', args, { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const save = (name, value) => fs.writeFileSync(dir + '/' + name, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
save('started.json', { startedAt, wrapperPid: process.pid, childPid: child.pid, cwd: process.cwd(), model: 'opus', maximumBudgetUsd: 8,
  briefSha256: createHash('sha256').update(brief).digest('hex'), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
let pending = '', result;
child.stdout.on('data', chunk => {
  fs.appendFileSync(dir + '/stdout.jsonl', chunk); pending += chunk.toString();
  let end; while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try { const event = JSON.parse(line);
      if (event.type === 'result') { result = event; fs.writeFileSync(dir + '/result.json', JSON.stringify(event, null, 2) + '\n'); }
      for (const block of event.message?.content ?? []) if (block.type === 'tool_use') fs.appendFileSync(dir + '/progress.jsonl', JSON.stringify({ at: new Date().toISOString(), tool: block.name, path: block.input?.file_path ?? block.input?.path ?? null }) + '\n');
    } catch { /* Partial/non-JSON output is retained verbatim. */ }
  }
});
child.stderr.on('data', chunk => fs.appendFileSync(dir + '/stderr.log', chunk));
child.on('error', error => save('spawn-error.json', { message: error.message }));
child.on('close', (exitCode, signal) => { save('terminal.json', { startedAt, finishedAt: new Date().toISOString(), wrapperPid: process.pid, childPid: child.pid, exitCode, signal, resultSubtype: result?.subtype, isError: result?.is_error }); console.log(JSON.stringify({ exitCode, signal, resultSubtype: result?.subtype, isError: result?.is_error })); process.exitCode = exitCode ?? 1; });
child.stdin.end(brief); console.log(JSON.stringify({ startedAt, wrapperPid: process.pid, childPid: child.pid, model: 'opus' }));
