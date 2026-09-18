import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { styles, supportsColor } from "./style.mjs";

const { test } = NodeTest;
const assert = NodeAssert;
const ESC = String.fromCharCode(27);

test("colour is used only for a terminal that wants it", () => {
  assert.equal(supportsColor({ isTTY: true }, {}), true);
  assert.equal(supportsColor({ isTTY: false }, {}), false, "piped output stays plain");
  assert.equal(supportsColor({ isTTY: true }, { NO_COLOR: "1" }), false, "NO_COLOR is honoured");
  assert.equal(supportsColor({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(supportsColor(undefined, {}), false, "no stream is not a terminal");
});

test("styling wraps text, and falls back to the text itself", () => {
  assert.equal(styles(true).bold("Flow"), `${ESC}[1mFlow${ESC}[22m`);
  assert.equal(styles(false).bold("Flow"), "Flow");
  // A URL must survive styling untouched: people copy these out of the terminal.
  const url = "http://localhost:53760/pair#token=Z9C8NTVWTGPU";
  assert.ok(styles(true).cyan(url).includes(url));
  assert.equal(styles(false).cyan(url), url);
});
