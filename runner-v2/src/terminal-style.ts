// ANSI styling for the launcher's terminal output. Color is used only when the output is an interactive
// terminal (or FORCE_COLOR asks for it) and never when NO_COLOR is set, so pipes, logs and tests stay plain.

export interface TerminalStyle {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

/**
 * Same precedence as Node's own console coloring: FORCE_COLOR decides when set ("0"/"false" turn color off),
 * otherwise a non-empty NO_COLOR (https://no-color.org) or a non-TTY / dumb terminal turns it off.
 */
export function colorEnabled(stream: { readonly isTTY?: boolean }, environment: NodeJS.ProcessEnv = process.env): boolean {
  const force = environment.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  if (environment.NO_COLOR) return false;
  if (stream.isTTY !== true) return false;
  return environment.TERM !== "dumb";
}

function wrap(enabled: boolean, open: number, close: number): (text: string) => string {
  return enabled ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => text;
}

export function terminalStyle(enabled: boolean): TerminalStyle {
  return {
    enabled,
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    red: wrap(enabled, 31, 39),
    cyan: wrap(enabled, 36, 39),
  };
}

export const PLAIN_STYLE: TerminalStyle = terminalStyle(false);

/** Style for text written to `stream` (process.stdout by default). */
export function styleFor(stream: { readonly isTTY?: boolean } = process.stdout, environment: NodeJS.ProcessEnv = process.env): TerminalStyle {
  return terminalStyle(colorEnabled(stream, environment));
}

/** "code: message" launcher errors with the code dimmed, for the bin entry points; plain output is unchanged. */
export function formatCliError(message: string, style: TerminalStyle): string {
  if (!style.enabled) return message;
  const match = /^([a-z][a-z0-9_]*): ([\s\S]*)$/.exec(message);
  if (!match) return `${style.red(style.bold("Error:"))} ${message}`;
  return `${style.red(style.bold("Error:"))} ${match[2]} ${style.dim(`(${match[1]})`)}`;
}
