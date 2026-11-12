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
