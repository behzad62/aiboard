import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { runGit } from "./git-command.js";

type Input = Record<string, unknown>;

const WORKER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "AIBoard Worker",
  GIT_AUTHOR_EMAIL: "worker@aiboard.local",
  GIT_COMMITTER_NAME: "AIBoard Worker",
  GIT_COMMITTER_EMAIL: "worker@aiboard.local",
};

export function createGitTools(): NativeTool<unknown>[] {
  const tools: NativeTool<Input>[] = [
    {
      definition: definition("git.status", "Inspect exact Git worktree state", true),
      validate: objectInput,
      assessAccess: () => readAccess("git.status"),
      execute: async (_input, context) => {
        const output = await git(context, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        const entries = output.stdout
          .split("\0")
          .filter((entry) => entry.length >= 4)
          .map((entry) => ({
            index: entry[0],
            worktree: entry[1],
            path: entry.slice(3),
          }));
        return okJson({ entries });
      },
    },
    {
      definition: definition("git.diff", "Read a Git patch without changing state", true),
      validate: objectInput,
      assessAccess: () => readAccess("git.diff"),
      execute: async (input, context) => {
        const args = ["diff", "--no-ext-diff", "--full-index"];
        if (input.staged === true) args.push("--cached");
        if (input.base !== undefined) {
          if (!validRevision(input.base)) return invalidRevision();
          args.push(input.base);
        }
        args.push("--");
        const output = await git(context, args, false, 64 * 1024 * 1024);
        return { content: [{ type: "text", text: output.stdout }], isError: false };
      },
    },
    {
      definition: definition("git.log", "Read bounded commit history", true),
      validate: objectInput,
      assessAccess: () => readAccess("git.log"),
      execute: async (input, context) => {
        const limit = Number.isSafeInteger(input.limit)
          ? Math.min(100, Math.max(1, input.limit as number))
          : 20;
        const output = await git(context, [
          "log",
          `--max-count=${limit}`,
          "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e",
        ]);
        const commits = output.stdout
          .split("\x1e")
          .map((record) => record.trim())
          .filter(Boolean)
          .map((record) => {
            const [revision, parents, author, authoredAt, subject] = record.split("\x1f");
            return {
              revision,
              parents: parents ? parents.split(" ").filter(Boolean) : [],
              author,
              authoredAt,
              subject,
            };
          });
        return okJson({ commits });
      },
    },
    {
      definition: definition("git.show", "Show one revision and its patch", true),
      validate: objectInput,
      assessAccess: () => readAccess("git.show"),
      execute: async (input, context) => {
        const revision = input.revision ?? "HEAD";
        if (!validRevision(revision)) return invalidRevision();
        const output = await git(
          context,
          ["show", "--no-ext-diff", "--format=fuller", revision, "--"],
          false,
          64 * 1024 * 1024
        );
        return { content: [{ type: "text", text: output.stdout }], isError: false };
      },
    },
    {
      definition: {
        ...definition("git.commit", "Commit all task-workspace changes", false),
        effect: "workspace",
      },
      validate: (input) =>
        isObject(input) && typeof input.message === "string" && input.message.trim()
          ? { ok: true, value: input }
          : { ok: false, issues: ["message must be a non-empty string"] },
      assessAccess: () => ({
        capability: "git.commit",
        paths: [{ path: ".", access: "write" }],
      }),
      execute: async (input, context) => {
        const branch = await git(
          context,
          ["symbolic-ref", "--quiet", "HEAD"],
          true
        );
        const ref = branch.stdout.trim();
        if (
          branch.exitCode !== 0 ||
          !ref.startsWith("refs/heads/aiboard/") ||
          !ref.includes("/tasks/")
        ) {
          return failure(
            "protected_ref",
            "Workers may commit only to runner-owned task branches."
          );
        }
        await git(context, ["add", "-A"]);
        const changed = await git(context, ["diff", "--cached", "--quiet"], true);
        if (changed.exitCode === 0) {
          return failure("nothing_to_commit", "Task workspace has no staged changes.");
        }
        if (changed.exitCode !== 1) {
          return failure("git_state_error", changed.stderr || "Could not inspect staged changes.");
        }
        await runGit({
          cwd: workspace(context),
          args: ["commit", "-m", (input.message as string).trim()],
          env: WORKER_IDENTITY,
        });
        const revision = (await git(context, ["rev-parse", "HEAD"])).stdout.trim();
        return okJson({ revision, ref });
      },
    },
  ];
  return tools as NativeTool<unknown>[];
}

function definition(name: string, description: string, readOnly: boolean) {
  return {
    name,
    description,
    inputSchema: gitSchema(name),
    readOnly,
    effect: "none" as const,
  };
}

function gitSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "git.status":
      return objectSchema({}, []);
    case "git.diff":
      return objectSchema(
        {
          staged: { type: "boolean" },
          base: { type: "string", minLength: 1 },
        },
        []
      );
    case "git.log":
      return objectSchema(
        { limit: { type: "integer", minimum: 1, maximum: 100 } },
        []
      );
    case "git.show":
      return objectSchema(
        { revision: { type: "string", minLength: 1 } },
        []
      );
    case "git.commit":
      return objectSchema(
        { message: { type: "string", minLength: 1 } },
        ["message"]
      );
    default:
      throw new Error(`Unknown Git tool ${name}.`);
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function objectInput(input: unknown): ValidationResult<Input> {
  return isObject(input)
    ? { ok: true, value: input }
    : { ok: false, issues: ["input must be an object"] };
}

function isObject(input: unknown): input is Input {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readAccess(capability: string) {
  return {
    capability,
    paths: [{ path: ".", access: "read" as const }],
  };
}

function workspace(context: ToolExecutionContext): string {
  if (!context.workspacePath) throw new Error("Git tool requires a workspace.");
  return context.workspacePath;
}

async function git(
  context: ToolExecutionContext,
  args: readonly string[],
  allowFailure = false,
  maxOutputBytes?: number
) {
  return await runGit({
    cwd: workspace(context),
    args,
    allowFailure,
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
  });
}

function validRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._~^/-]*$/.test(value) &&
    !value.includes("..")
  );
}

function invalidRevision(): ToolExecutionOutput {
  return failure("invalid_revision", "Revision syntax is invalid.");
}

function okJson(value: unknown): ToolExecutionOutput {
  return { content: [{ type: "json", value }], isError: false };
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
