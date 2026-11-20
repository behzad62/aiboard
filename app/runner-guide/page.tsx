import Link from "next/link";
import { RunnerInstallCommands } from "@/components/runner/RunnerInstallCommands";
import { GIT_FOR_WINDOWS_URL, RUNNER_REMOTE_COMMAND, RUNNER_START_COMMAND, RUNNER_UPDATE_COMMAND } from "@/lib/runner-install";
import { pageMetadata, SITE_REMOTE_ENABLED } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Runner V2 guide",
  description:
    "Install the AI Board Runner with one command, start it in a project folder, keep your settings and keys in the AIBoard home, and connect Chat, Build mode and account providers to real files, Git, and shell access on your computer.",
  path: "/runner-guide",
});

export default function RunnerGuidePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Runner V2 guide</h1>
        <p className="mt-2 text-muted-foreground">
          Every model call, Build mode, and account providers such as ChatGPT and GitHub Copilot run through the AI
          Board Runner on your own computer. It keeps your settings and keys in the AIBoard home. There is no browser
          execution fallback.
        </p>
      </header>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Install</h2>
        <p>
          Open a terminal and run the line for your system. It installs for your user only (no admin rights), checks
          the signed release before anything runs, and adds <code>{RUNNER_START_COMMAND}</code> to your PATH. Node.js
          is included. Then open a new terminal.
        </p>
        <RunnerInstallCommands />
        <p className="text-sm text-muted-foreground">
          Build mode also needs Git. Without it the Runner still starts, with Chat and account providers only: install{" "}
          <a className="underline hover:text-foreground" href={GIT_FOR_WINDOWS_URL}>Git for Windows</a>, run{" "}
          <code>xcode-select --install</code> on macOS, or use your Linux package manager.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Start it in a project folder</h2>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">
          {`cd path/to/your-project\n${RUNNER_START_COMMAND}`}
        </pre>
        <p>
          It opens AI Board in your browser and connects this computer, with nothing to paste. The same command
          starts the account runner for ChatGPT and GitHub Copilot. Keep the terminal open; Ctrl+C stops
          the Runner. Start it in a project folder, not your home folder.
        </p>
        <p className="text-sm text-muted-foreground">
          <code>aiboard status</code> and <code>aiboard stop</code> manage a running Runner,{" "}
          <code>aiboard runner</code> starts it without the account runner, and <code>aiboard --help</code> lists
          every option.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Settings and keys: the AIBoard home</h2>
        <p>
          Your settings and keys live in one folder on your computer, the AIBoard home: <code>~/.aiboard</code>{" "}
          (<code>C:\Users\&lt;you&gt;\.aiboard</code> on Windows), or the absolute folder you set in{" "}
          <code>AIBOARD_HOME</code>. <code>config.json</code> holds settings and no secret. Keys are encrypted in{" "}
          <code>credentials.json</code> with a key kept in your user data folder, outside the home, so a copied or
          synced home carries no usable keys. Settings in the browser and the commands below edit the same home, and
          the browser reaches it only through the Runner: model calls from the page go through the Runner, which adds
          the key and forwards them to the provider.
        </p>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">
          {`aiboard config [--json]
aiboard config set defaults.reasoningEffort <effort>
aiboard keys set <provider> [--stdin]
aiboard keys remove <provider>
aiboard keys reset
aiboard models [--json]
aiboard models enable <provider:model>
aiboard models disable <provider:model>`}
        </pre>
        <p className="text-sm text-muted-foreground">
          <code>aiboard config</code> shows where the home and its key are, your providers with key hints, the
          enabled models, and your defaults. <code>aiboard keys set</code> asks for the key with your typing hidden,
          or reads one line from a pipe with <code>--stdin</code>; it never takes a key as an argument, and the key
          shows as not validated until Settings validates it. <code>aiboard keys reset</code> removes every saved
          key after a confirmation, for example when the keys were saved on another computer.{" "}
          <code>aiboard models</code> lists, enables and disables models. These commands start no Runner and make no
          network call. Custom models and pricing are edited in Settings.
        </p>
        <p className="text-sm text-muted-foreground">
          Any program running as your user can read the home and its key, as with other command-line tools that keep
          keys in your user folder; there is no passphrase. Commands that a task runs at an unconfined access level
          can read them too. <code>aiboard uninstall --remove-state</code> deletes the home&apos;s files with the rest
          of AI Board&apos;s data.
        </p>
      </section>
      {SITE_REMOTE_ENABLED && <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Let ChatGPT or Claude use this computer</h2>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">{RUNNER_REMOTE_COMMAND}</pre>
        <p>
          Connects this computer to AI Board Remote so cloud agents can use it. Read the notice it prints first:
          remote agents act as your user account. Ctrl+C disconnects.
        </p>
      </section>}
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Update and remove</h2>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">
          {`${RUNNER_UPDATE_COMMAND}\naiboard update --rollback\naiboard uninstall`}
        </pre>
        <p className="text-sm text-muted-foreground">
          Updates are signed and checked like the first install. <code>aiboard doctor</code> shows the installed
          version, Node.js, and Git.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Access and handoff</h2>
        <p>
          Guarded access pauses for every mutation. Project Autonomous runs project-contained work without prompts
          but pauses for outside or external effects. Full Access allows destructive, credential, push/PR,
          deployment, and external-system operations without per-action approval. In every profile, a Build&apos;s
          final project handoff pauses for your choice unless the run&apos;s policy is finish or budgeted, a project
          handoff was requested, and no known defects are recorded; a failed automatic apply pauses for you.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Final checks</h2>
        <p>
          Before planning, the Runner records which tools this computer has. The Build&apos;s final check is a list the
          Architect writes: it keeps, changes or skips the Runner&apos;s suggested checks, giving a reason for each skip,
          and adds its own. Checks are build, tests, start or other. A check whose tool is missing is recorded as not
          run (<code>tool_missing</code>), never as a failure, so no repairs are spent on it.
        </p>
        <p>
          Your project decides which checks are mandatory, in <code>aiboard-validation.json</code> at the repository
          root, version 2. The Architect can never skip or change a mandatory check. When the file declares checks,
          they are the whole suggestion list; the checks the Runner detects from your project&apos;s files are used
          only when it declares none.
        </p>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">
          {`{
  "version": 2,
  "checks": [
    { "id": "typecheck", "label": "Type check", "kind": "build", "mandatory": true,
      "run": { "executable": "npm", "args": ["run", "typecheck"], "timeoutMs": 600000 } },
    { "id": "unit", "label": "Unit tests", "kind": "tests", "mandatory": false,
      "run": { "executable": "npm", "args": ["test"] } },
    { "id": "serve", "label": "The server answers", "kind": "start", "mandatory": false,
      "start": { "executable": "node", "args": ["server.js", "--port", "{port}"],
        "ready": { "http": { "path": "/health", "status": 200 } } } }
  ]
}`}
        </pre>
        <p className="text-sm text-muted-foreground">
          Commands are a program and its arguments, never a shell line. A start check runs a program and sees that it
          works: ready on an HTTP status on the port the Runner leases (<code>{"{port}"}</code> in its arguments), on a
          line it prints (<code>outputLine</code>), or on its exit code (<code>exitCode</code>), and its{" "}
          <code>steps</code> then run against it. <code>outputs</code> keeps files such as screenshots and reports as
          evidence.
        </p>
        <p>A Build stops for its checks only when it matters:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            A mandatory check&apos;s tool is missing: one pause before planning, naming the tool and the file&apos;s
            line. Install the tool and resume.
          </li>
          <li>
            <code>aiboard-validation.json</code> is malformed or unreadable: the run stops before planning. A malformed
            file stays malformed at the revision the run reads, so fix it and start a new Build. A file the Runner
            could not read (no permission, a file another program held) can pass on a resume, which reads a fresh
            checkout.
          </li>
          <li>
            A mandatory check still fails after its repairs: the Build pauses. A check that is not mandatory becomes a
            known defect instead, and the Build goes on to its handoff, which pauses for your choice.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          The handoff&apos;s Not verified section, and the same list in Run details, shows every check that did not
          run and why, every skip, every known defect, every result the Architect accepted without the Runner&apos;s
          evidence, and what the Architect left for you to check.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Browsing</h2>
        <p>
          Builds open and check web pages with the Playwright CLI that ships with the Runner. Workers, the Architect
          and the verifiers run <code>playwright-cli</code> as an ordinary command, with one browser session for each
          task that stops with the task. A final check opens a browser with a start check whose program is{" "}
          <code>playwright-cli-session</code>, ready on the line <code>Daemon listening on</code>, and whose steps run{" "}
          <code>playwright-cli</code>; the Runner stops the browser after the last step. It browses a page that is
          already served, and a <code>playwright-cli</code> command that fails makes its step fail.
        </p>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">aiboard browser install</pre>
        <p className="text-sm text-muted-foreground">
          The CLI uses an installed Google Chrome first, then Microsoft Edge, then Playwright&apos;s Chromium. A Build
          never downloads a browser: <code>aiboard browser install</code> or the Install browser button in Settings &gt;
          Tools, downloads Chromium only when you choose to. On Linux, Chromium&apos;s system libraries need root, so the
          Runner prints the command for you to run.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">CLI workers</h2>
        <p>
          A Build can use Codex CLI, Claude Code and agy, signed in on this computer, as workers next to API models (Runner 0.3.21
          or newer: <code>aiboard update</code>). Turn each one on in Settings &gt; Providers &gt; CLI workers.
          Settings shows whether the CLI is installed and logged in, and suggests models. Test sends one tiny prompt in
          the CLI&apos;s most restricted mode, in an empty folder, and uses a little of that CLI&apos;s usage.
        </p>
        <p>
          The CLI signs in with its own login: AI Board never reads that login or keeps a key for it. Sign in with the
          CLI&apos;s own login command, because a key or token in an environment variable doesn&apos;t reach a
          Build&apos;s processes. A CLI&apos;s use isn&apos;t counted toward a USD budget, so a Budgeted Build with a CLI
          worker also needs a time limit. Each CLI attempt has its own limit: 90 minutes by default, 5 to 240 in
          Settings.
        </p>
        <p>
          CLI workers are workers only, never the Architect, a reviewer or a verifier. They need Full Access, because a
          CLI runs commands as you with its own permission prompts turned off. So it can reach what you can, and:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>the Runner can&apos;t undo a push or a write outside the worktree;</li>
          <li>
            the Runner tells the Architect when your project folder&apos;s Git state (HEAD, index or changed files)
            changed while the CLI ran;
          </li>
          <li>your own CLI setup (hooks, MCP servers, plugins, instruction files) runs in Builds too.</li>
        </ul>
        <p>The Runner starts the CLI in the task&apos;s worktree. When the CLI finishes, the Runner:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            stops everything the CLI left running (a dev server, a watcher, its browser) and proves it has stopped;
          </li>
          <li>
            undoes the CLI&apos;s own commits, keeping their changes, and puts back any change to{" "}
            <code>docs/project</code>;
          </li>
          <li>runs the checks the CLI reports again itself;</li>
          <li>
            when every criterion has a passing check, submits the work for review like any worker&apos;s. If a check
            fails, or a criterion has no passing check, the CLI gets one fix round. If a criterion still has none after
            it, the attempt fails, unless the time budget cut its check short: the work then goes on, with that
            criterion marked not verified. A question, or a &quot;can&apos;t do this&quot;, goes to the Architect.
          </li>
        </ul>
        <p>
          A stop it can&apos;t prove pauses the Build and keeps the task&apos;s work. The pause says what failed: close
          any leftover program it names, then Resume, which tries the stop again. Collecting the CLI&apos;s work can
          take a second Resume.
        </p>
        <p>
          When a CLI is out of usage or logged out, its task moves, in the same worktree, to another healthy worker (an
          API or CLI worker), with a summary of the work so far. If no healthy worker is left, the Build pauses. All of
          that CLI&apos;s workers cool down together, and a passing Test ends the cooldown.
        </p>
        <p className="text-sm text-muted-foreground">
          CLI workers run on Windows only for now, and only where Windows passes the Runner&apos;s Job check; Settings
          says when it doesn&apos;t. On Linux and macOS, every CLI worker is refused:
        </p>
        <ul className="list-disc space-y-1 pl-6 text-sm text-muted-foreground">
          <li>
            on Linux, Claude Code and Codex run commands outside the process group the Runner can stop, and agy
            wasn&apos;t measured;
          </li>
          <li>macOS wasn&apos;t measured.</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Use Claude Code&apos;s native <code>claude.exe</code>: its npm <code>.cmd</code> shim is refused.
        </p>
        <p className="text-sm text-muted-foreground">
          Codex CLI workers need a Runner newer than 0.3.22. A worker runs the Codex CLI, installed with OpenAI&apos;s
          installer (<code>irm https://chatgpt.com/codex/install.ps1 | iex</code>, which puts <code>codex</code> on
          your PATH) or with npm. The Codex desktop app from the Microsoft Store bundles its own <code>codex.exe</code>
          inside its package, and that one isn&apos;t run as a worker, because the programs it starts could run outside
          the Runner&apos;s Job. The CLI installs next to the desktop app: both use the <code>.codex</code> folder in
          your user profile. A Codex worker&apos;s commands run in Windows PowerShell, or in PowerShell 7 if you installed it from its
          installer: the Microsoft Store PowerShell is left off the worker&apos;s PATH, because the programs it starts
          run outside the Job. A server a CLI worker starts, such as a dev server, stops when its attempt ends.
        </p>
        <p className="text-sm text-muted-foreground">
          One gap remains on Windows, for every worker: a program you installed only from the Microsoft Store (the
          Store PowerShell, a Store Python, winget) still starts outside the Runner&apos;s Job when a command starts it by
          name with <code>Start-Process</code> or <code>start</code>, and it can keep running after the Build stops it.
          Install such tools from their own installers if workers may start them.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Recovery</h2>
        <p>
          Run <code>{RUNNER_START_COMMAND}</code> again in the same project folder. Its state lives in your user data
          folder, and durable sessions, task state, evidence, and Git integration state recover before work continues.
        </p>
        <p className="text-sm text-muted-foreground">
          Repository contributors can run <code>npm run runner:v2 -- --project ...</code> from an AI Board checkout
          instead.
        </p>
      </section>
      <p><Link href="/" className="underline hover:text-foreground">Back to the workspace</Link></p>
    </article>
  );
}
