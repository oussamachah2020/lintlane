// Tiny terminal styling helpers. No dependencies.
// Color follows the usual conventions: NO_COLOR disables it, FORCE_COLOR
// forces it, otherwise it's on only when stdout is a TTY.

const env = process.env;
export const useColor =
  env.NO_COLOR !== undefined && env.NO_COLOR !== ""
    ? false
    : env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== ""
      ? env.FORCE_COLOR !== "0"
      : Boolean(process.stdout.isTTY) && env.TERM !== "dumb";

const wrap = (open, close) => (text) =>
  useColor ? `\u001b[${open}m${text}\u001b[${close}m` : String(text);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  badge: (text) => (useColor ? `\u001b[1;30;46m ${text} \u001b[0m` : text),
};

export const SYMBOLS = {
  ok: c.green("✔"),
  warn: c.yellow("!"),
  fail: c.red("✘"),
  plan: c.cyan("+"),
  step: c.cyan("▶"),
  skip: c.gray("-"),
  arrow: c.gray("↳"),
};

// Highlight `code` and "quoted" fragments; dim everything after " — "
// (the secondary explanation). Plain text is unchanged without color.
export function pretty(message) {
  if (!useColor) return message;
  const highlight = (text, base = (s) => s) =>
    text
      .split(/(`[^`]+`|"[^"]+")/)
      .map((part, i) => (i % 2 ? c.cyan(part) : base(part)))
      .join("");
  const at = message.indexOf(" — ");
  if (at < 0) return highlight(message);
  return `${highlight(message.slice(0, at))}${c.dim(" — ")}${highlight(message.slice(at + 3), c.dim)}`;
}

const INDENT = "  ";

export function line(symbol, message, hint) {
  console.log(`${INDENT}${symbol} ${pretty(message)}`);
  if (hint) console.log(`${INDENT}  ${SYMBOLS.arrow} ${c.dim(pretty(hint))}`);
}

export function section(title) {
  console.log(`\n${INDENT}${c.bold(title)}`);
}

export function header(name, version, command) {
  console.log(
    `\n${INDENT}${c.badge(name)} ${c.dim(`v${version}`)}${command ? c.dim(`  ·  ${command}`) : ""}`,
  );
}
