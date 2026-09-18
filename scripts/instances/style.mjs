// Terminal styling for the handful of lines a person actually reads: the
// address Flow is on, and what to do next. Everything respects NO_COLOR and
// goes plain when stdout is not a terminal, so piped or logged output stays
// readable (https://no-color.org).
export const supportsColor = (stream = process.stdout, env = process.env) =>
  Boolean(stream?.isTTY) && !env.NO_COLOR && env.TERM !== "dumb";

const ESC = String.fromCharCode(27);
const codes = {
  bold: [1, 22],
  dim: [2, 22],
  underline: [4, 24],
  cyan: [36, 39],
  green: [32, 39],
  yellow: [33, 39],
};

/** Styling functions that fall back to returning the text unchanged. */
export function styles(enabled = supportsColor()) {
  const style = ([on, off]) =>
    enabled ? (text) => `${ESC}[${on}m${text}${ESC}[${off}m` : (text) => String(text);
  return Object.fromEntries(Object.entries(codes).map(([name, pair]) => [name, style(pair)]));
}
