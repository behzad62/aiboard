import assert from "node:assert/strict";
import test from "node:test";

import { colorEnabled, formatCliError, PLAIN_STYLE, terminalStyle } from "../src/terminal-style.js";

test("color follows the terminal, NO_COLOR and FORCE_COLOR", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(colorEnabled(tty, {}), true);
  assert.equal(colorEnabled(pipe, {}), false);
  assert.equal(colorEnabled({}, {}), false);
  assert.equal(colorEnabled(tty, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled(tty, { NO_COLOR: "" }), true, "an empty NO_COLOR is ignored (no-color.org)");
  assert.equal(colorEnabled(tty, { TERM: "dumb" }), false);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled(tty, { FORCE_COLOR: "0" }), false);
  assert.equal(colorEnabled(tty, { FORCE_COLOR: "false" }), false);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: "1", NO_COLOR: "1" }), true, "FORCE_COLOR decides when set, as in Node");
});

test("styles wrap text only when enabled", () => {
  assert.equal(PLAIN_STYLE.green("ok"), "ok");
  assert.equal(terminalStyle(true).green("ok"), "\u001b[32mok\u001b[39m");
  assert.equal(terminalStyle(true).bold("ok"), "\u001b[1mok\u001b[22m");
});

test("CLI errors stay byte-identical without color and highlight the message with it", () => {
  const message = "invalid_arguments: Unknown launcher option. See --help.";
  assert.equal(formatCliError(message, PLAIN_STYLE), message);
  assert.equal(formatCliError(message, terminalStyle(true)),
    "\u001b[31m\u001b[1mError:\u001b[22m\u001b[39m Unknown launcher option. See --help. \u001b[2m(invalid_arguments)\u001b[22m");
  assert.equal(formatCliError("Something broke", terminalStyle(true)), "\u001b[31m\u001b[1mError:\u001b[22m\u001b[39m Something broke");
});
