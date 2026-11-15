/**
 * Codex runs each command as `<shell> -lc <script>` (`/bin/zsh -lc "git status"`). The script is
 * what the rules and the read-only list must see. Unwrapped only when the launch is exactly one
 * known shell, `-c`/`-lc` and one word made of quoted parts; anything else stays as it is (and is
 * then never read-only).
 */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
]);
/** In double quotes, bash removes the backslash only before these. */
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n"]);

export const unwrapShellLaunch = (command: string): string | undefined => {
  const match = /^(\S+) (-c|-lc) (.+)$/s.exec(command.trim());
  if (match === null || !SHELLS.has(match[1]!)) return undefined;
  const word = match[3]!;
  let script = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i]!;
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      if (end < 0) return undefined;
      script += word.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i += 1;
      let closed = false;
      while (i < word.length) {
        const d = word[i]!;
        if (d === "\\" && i + 1 < word.length && DOUBLE_QUOTE_ESCAPES.has(word[i + 1]!)) {
          script += word[i + 1] === "\n" ? "" : word[i + 1];
          i += 2;
        } else if (d === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          script += d;
          i += 1;
        }
      }
      if (!closed) return undefined;
    } else if (/[A-Za-z0-9_./:=@%+,-]/.test(c)) {
      script += c;
      i += 1;
    } else {
      // An unquoted space, `$`, glob, escape or operator: more than one plain word.
      return undefined;
    }
  }
  return script === "" ? undefined : script;
};
