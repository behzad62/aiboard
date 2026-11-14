export declare const START_INSTRUCTION: string;
export declare function parseCliArguments(argv: readonly string[], roots?: { playwright: string; core: string }): Record<string, unknown> & { _?: unknown[] };
export declare function refusalFor(argv: readonly string[], ownSession: string | undefined, parse?: (argv: readonly string[]) => Record<string, unknown> & { _?: unknown[] }): string | undefined;
export declare function rewriteNotOpen(text: string): string;
/** True when the CLI printed a failed command result ("isError": true first with --json, "### Error" first as text). */
export declare function cliOutputFailed(output: string): boolean;
export declare function sanitizeCliEnvironment(environment: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
export declare function main(argv?: readonly string[], environment?: NodeJS.ProcessEnv): void;
