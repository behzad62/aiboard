export declare const START_INSTRUCTION: string;
export declare function parseCliArguments(argv: readonly string[], roots?: { playwright: string; core: string }): Record<string, unknown> & { _?: unknown[] };
export declare function refusalFor(argv: readonly string[], ownSession: string | undefined, parse?: (argv: readonly string[]) => Record<string, unknown> & { _?: unknown[] }): string | undefined;
export declare function rewriteNotOpen(text: string): string;
/** How the CLI prints these arguments' result: with --json, raw (no headings: --raw or a raw-by-default command), or as text. */
export declare function cliOutputMode(argv: readonly string[], roots?: { playwright: string; core: string }, parse?: (argv: readonly string[]) => Record<string, unknown> & { _?: unknown[] }): "json" | "raw" | "text";
/** True when the CLI printed a failed command result: "isError": true first with --json, "### Error" first as text; raw output never. */
export declare function cliOutputFailed(output: string, mode: "json" | "raw" | "text"): boolean;
export declare function sanitizeCliEnvironment(environment: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
export declare function main(argv?: readonly string[], environment?: NodeJS.ProcessEnv): void;
