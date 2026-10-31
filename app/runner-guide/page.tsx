import Link from "next/link";
import { RunnerInstallCommands } from "@/components/runner/RunnerInstallCommands";
import { GIT_FOR_WINDOWS_URL, RUNNER_REMOTE_COMMAND, RUNNER_START_COMMAND, RUNNER_UPDATE_COMMAND } from "@/lib/runner-install";
import { pageMetadata, SITE_REMOTE_ENABLED } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Runner V2 guide",
  description:
    "Install the AI Board Runner with one command, start it in a project folder, and connect Build mode and account providers to real files, Git, and shell access on your computer.",
  path: "/runner-guide",
});

export default function RunnerGuidePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Runner V2 guide</h1>
        <p className="mt-2 text-muted-foreground">
          Build mode, and account providers such as ChatGPT and GitHub Copilot, run through the AI Board Runner on
          your own computer. There is no browser execution fallback.
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
          starts the account runner for ChatGPT, GitHub Copilot, and NVIDIA. Keep the terminal open; Ctrl+C stops
          the Runner. Start it in a project folder, not your home folder.
        </p>
        <p className="text-sm text-muted-foreground">
          <code>aiboard status</code> and <code>aiboard stop</code> manage a running Runner,{" "}
          <code>aiboard runner</code> starts it without the account runner, and <code>aiboard --help</code> lists
          every option.
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
          deployment, and external-system operations without per-action approval. Final project handoff is always
          a user choice in every profile.
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
