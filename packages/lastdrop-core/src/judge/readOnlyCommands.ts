/**
 * Commands Claude Code 2.1.319 runs without a check, allowed without the judge (headroom
 * `ReadOnlyCommands.swift`; flag tables are data). Never looser than Claude Code: an unknown flag, `$`,
 * a backtick, a file redirect, a subshell or control flow is never read-only.
 */
import { chars, count, isWhitespace, splitAtSpaces, trim, WHITESPACE } from "./swiftText.ts";
import { splitCommand, unwrapCommand } from "./permissionRules.ts";
import { FLAG_TABLES, type FlagValue } from "./readOnlyFlagTables.ts";

type Table = Readonly<Record<string, FlagValue>>;

const isDigits = (text: string): boolean => /^[0-9]+$/.test(text);
const lookup = (table: Table, key: string): FlagValue | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
const tableFor = (name: string): Table | undefined =>
  Object.prototype.hasOwnProperty.call(FLAG_TABLES, name) ? FLAG_TABLES[name] : undefined;

/** The read-only commands `command` is made of (`["git status", "ls"]`), or undefined when any part isn't one. */
export const readOnlyCommands = (input: string): Array<string> | undefined => {
  const command = trim(input);
  // A carriage return is never read-only: bash splits at "\r\n", Swift does not (stricter than both).
  if (command === "" || command.includes("\r") || command.includes("$") || command.includes("`") || backgrounds(command))
    return undefined;
  const parts = splitCommand(command, false);
  if (parts === undefined || parts.length === 0) return undefined;
  const names: Array<string> = [];
  for (const part of parts) {
    const unwrapped = unwrapCommand(part, true);
    if (unwrapped.blocked) return undefined;
    const words = commandWords(unwrapped.text);
    if (words === undefined) return undefined;
    const name = readOnlyName(words);
    if (name === undefined) return undefined;
    if (!names.includes(name)) names.push(name);
  }
  return names;
};

/** An unquoted `&` that sends a command to the background (not `&&`, `2>&1` or `&>`). */
export const backgrounds = (command: string): boolean => {
  let single = false;
  let double = false;
  let escaped = false;
  let masked = "";
  for (const c of chars(command)) {
    if (escaped) {
      escaped = false;
      masked += "_";
      continue;
    }
    if (c === "\\" && !single) {
      escaped = true;
      masked += "_";
      continue;
    }
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    masked += single || double ? "_" : c;
  }
  return masked.replace(/&&|[<>]&|&>/g, " ").includes("&");
};

const HARMLESS = new Set([
  "2>&1",
  "1>&2",
  ">&2",
  "2>/dev/null",
  ">/dev/null",
  "1>/dev/null",
  "&>/dev/null",
]);

/**
 * The part's words with quotes removed, without the harmless redirections `2>&1` and `>/dev/null`.
 * Undefined when an unquoted `<`, `>`, `(`, `)`, `{`, `}` or `\` is left: a redirection, a subshell,
 * a brace expansion or an escape.
 */
export const commandWords = (part: string): Array<string> | undefined => {
  const raw: Array<{ text: string; quoted: string }> = [];
  let text = "";
  let masked = "";
  let single = false;
  let double = false;
  let escaped = false;
  let started = false;
  for (const c of chars(part)) {
    if (escaped) {
      escaped = false;
      text += c;
      masked += "_";
      continue;
    }
    if (!single && !double && isWhitespace(c)) {
      if (started) {
        raw.push({ text, quoted: masked });
        text = "";
        masked = "";
        started = false;
      }
      continue;
    }
    started = true;
    if (c === "'" && !double) {
      single = !single;
      masked += "_";
      continue;
    }
    if (c === '"' && !single) {
      double = !double;
      masked += "_";
      continue;
    }
    if (double && c === "\\") {
      escaped = true;
      masked += "_";
      continue;
    }
    text += c;
    masked += single || double ? "_" : c;
  }
  if (single || double) return undefined;
  if (started) raw.push({ text, quoted: masked });
  const words: Array<string> = [];
  let i = 0;
  while (i < raw.length) {
    const quoted = raw[i]!.quoted;
    if (HARMLESS.has(quoted)) {
      i += 1;
      continue;
    }
    if (
      ["2>", ">", "&>"].includes(quoted) &&
      i + 1 < raw.length &&
      raw[i + 1]!.quoted === "/dev/null"
    ) {
      i += 2;
      continue;
    }
    if (chars(quoted).some((c) => "<>(){}\\".includes(c))) return undefined;
    words.push(raw[i]!.text);
    i += 1;
  }
  return words;
};

/** Any arguments: these only read or print. */
export const PLAIN = new Set([
  "cal",
  "uptime",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "strings",
  "hexdump",
  "od",
  "nl",
  "id",
  "uname",
  "free",
  "df",
  "du",
  "locale",
  "groups",
  "nproc",
  "basename",
  "dirname",
  "realpath",
  "cut",
  "paste",
  "tr",
  "column",
  "tac",
  "rev",
  "fold",
  "expand",
  "unexpand",
  "fmt",
  "comm",
  "cmp",
  "numfmt",
  "readlink",
  "diff",
  "true",
  "false",
  "sleep",
  "type",
  "expr",
  "seq",
  "tsort",
  "pr",
]);

/** Only with no arguments. */
export const BARE = new Set(["pwd", "whoami", "alias"]);

/** Only exactly these. */
export const EXACT = new Set([
  "claude -h",
  "claude --help",
  "node -v",
  "node --version",
  "python --version",
  "python3 --version",
  "ip addr",
  "docker ps",
  "docker images",
]);

/** `find` actions that run, delete or write. */
export const FIND_ACTIONS = new Set([
  "-rm",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
  "-files0-from",
]);

/** The read-only command's name for the log, or undefined. */
export const readOnlyName = (words: ReadonlyArray<string>): string | undefined => {
  const first = words[0];
  if (first === undefined) return undefined;
  const args = words.slice(1);
  const joined = words.join(" ");
  if (EXACT.has(joined)) return joined;
  if (first === "docker" && (args[0] === "ps" || args[0] === "images")) return `docker ${args[0]}`;
  if (PLAIN.has(first) || first === "ls") return first;
  if (BARE.has(first)) return args.length === 0 ? first : undefined;
  switch (first) {
    case "echo":
      return args.every((arg) => !arg.includes("#") && !arg.includes("!")) ? first : undefined;
    case "printf":
      return printfIsSafe(args) ? first : undefined;
    case "cd":
      return args.length <= 1 ? first : undefined;
    case "find":
      return args.some((arg) => FIND_ACTIONS.has(arg)) ? undefined : first;
    case "history":
      return args.length === 0 || (args.length === 1 && /^[+-]?[0-9]+$/.test(args[0]!))
        ? first
        : undefined;
    case "arch":
      return args.length === 0 || (args.length === 1 && ["-h", "--help"].includes(args[0]!))
        ? first
        : undefined;
    case "ifconfig":
      return args.length <= 1 && !(args[0]?.startsWith("-") ?? false) ? first : undefined;
    case "uniq":
      return uniqIsSafe(args) ? first : undefined;
    case "jq":
      return jqIsSafe(args) ? first : undefined;
    case "test":
    case "[":
    case "[[":
      return testIsSafe(args) ? first : undefined;
    case "git":
      return gitReadOnly(args);
    case "gh":
      return ghReadOnly(args);
    case "docker":
      return dockerReadOnly(args);
    case "xargs":
      return xargsReadOnly(args);
    default:
      break;
  }
  const table = tableFor(first);
  if (table === undefined || !flagsAllowed(args, table, first) || dangerous(first, args))
    return undefined;
  return first;
};

const isFlag = (word: string): boolean => count(word) > 1 && /^-[a-zA-Z0-9_-]/.test(word);

/**
 * Claude Code's flag rule: every flag in the table, by its name before `=`; a value of the flag's kind
 * (a string not starting with `-`, digits, one character). Short flags cluster only when none takes a
 * value; `git log -20` and `grep -A3` are understood; after `--` every word is an argument.
 */
export const flagsAllowed = (
  args: ReadonlyArray<string>,
  table: Table,
  command: string,
): boolean => {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") return true;
    if (!arg.startsWith("-") || count(arg) <= 1) {
      i += 1;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const attached = equals < 0 ? undefined : arg.slice(equals + 1);
    if (name === "") return false;
    const kind = lookup(table, name);
    if (kind === undefined) {
      if (command === "git" && /^-\d+$/.test(name)) {
        i += 1;
        continue;
      }
      if (
        ["grep", "egrep", "fgrep", "rg"].includes(command) &&
        !name.startsWith("--") &&
        count(name) > 2
      ) {
        const short = lookup(table, name.slice(0, 2));
        if (short === "number" || short === "string") {
          if (chars(name.slice(2)).every((c) => /[0-9]/.test(c))) {
            i += 1;
            continue;
          }
        }
      }
      if (!name.startsWith("--") && count(name) > 2) {
        for (const letter of chars(name).slice(1))
          if (lookup(table, `-${letter}`) !== "none") return false;
        i += 1;
        continue;
      }
      return false;
    }
    if (kind === "none") {
      if (attached !== undefined) return false;
      i += 1;
      continue;
    }
    let value: string;
    if (attached !== undefined) {
      value = attached;
      i += 1;
    } else {
      const next = args[i + 1];
      if (next === undefined || isFlag(next)) return false;
      value = next;
      i += 2;
    }
    if (
      kind === "string" &&
      value.startsWith("-") &&
      !(command === "git" && name === "--sort" && /^-[a-zA-Z]/.test(value))
    )
      return false;
    switch (kind) {
      case "string":
        break;
      case "number":
        if (!isDigits(value)) return false;
        break;
      case "char":
        if (count(value) !== 1) return false;
        break;
      case "braces":
        if (value !== "{}") return false;
        break;
      case "eof":
        if (value !== "EOF") return false;
        break;
    }
  }
  return true;
};

const TPUT_REFUSED = new Set([
  "init",
  "reset",
  "rs1",
  "rs2",
  "rs3",
  "is1",
  "is2",
  "is3",
  "iprog",
  "if",
  "rf",
  "clear",
  "flash",
  "mc0",
  "mc4",
  "mc5",
  "mc5i",
  "mc5p",
  "pfkey",
  "pfloc",
  "pfx",
  "pfxl",
  "smcup",
  "rmcup",
]);

/** Claude Code's extra checks for commands whose flags alone don't make them safe. */
export const dangerous = (command: string, args: ReadonlyArray<string>): boolean => {
  switch (command) {
    case "sed":
      return !sedIsSafe(args);
    case "date": {
      // `date 0101…` sets the clock: words must be `+FORMAT`, apart from these flags' values.
      const values = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
      let i = 0;
      while (i < args.length) {
        const arg = args[i]!;
        if (arg.startsWith("--") && arg.includes("=")) i += 1;
        else if (arg.startsWith("-")) i += values.has(arg) ? 2 : 1;
        else {
          if (!arg.startsWith("+")) return true;
          i += 1;
        }
      }
      return false;
    }
    case "hostname":
      // Flags only: a name would set it.
      return !args.every((arg) => /^(-[a-zA-Z]|--[a-zA-Z-]+)$/.test(arg));
    case "which": {
      let after = false;
      for (const arg of args) {
        if (after) continue;
        if (arg === "--") after = true;
        else if (arg.startsWith("-") && !/^(-[A-Za-z]+|--[a-z-]+)$/.test(arg)) return true;
      }
      return false;
    }
    case "tput": {
      // Capabilities that reset or reprogram the terminal, and `-S` (capabilities from stdin).
      let i = 0;
      let after = false;
      while (i < args.length) {
        const arg = args[i]!;
        if (arg === "--") {
          after = true;
          i += 1;
        } else if (!after && arg.startsWith("-")) {
          if (arg === "-S" || (!arg.startsWith("--") && count(arg) > 2 && arg.includes("S")))
            return true;
          i += arg === "-T" ? 2 : 1;
        } else {
          if (TPUT_REFUSED.has(arg)) return true;
          i += 1;
        }
      }
      return false;
    }
    default:
      return false;
  }
};

/** No option (`printf -v` writes a variable), and only plain text, `%s`-like conversions and simple escapes. */
export const printfIsSafe = (args: ReadonlyArray<string>): boolean => {
  const format = args[0];
  if (format === undefined || format.startsWith("-")) return false;
  if (/\\(u|U|x|[0-7])/.test(format)) return false;
  if (/%[-+ #0-9.]*[diouxXeEfFgGaAc]/.test(format))
    return args.slice(1).every((arg) => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(arg));
  return true;
};

/** Flags only: no input or output file (Claude Code 2.1.319 refuses `uniq a.txt` too). */
export const uniqIsSafe = (args: ReadonlyArray<string>): boolean => {
  const flags = new Set([
    "-c",
    "--count",
    "-d",
    "--repeated",
    "-D",
    "-u",
    "--unique",
    "-i",
    "--ignore-case",
    "-z",
    "--zero-terminated",
  ]);
  const values = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    i += 1;
    if (flags.has(arg)) continue;
    const name = arg.split("=")[0] ?? "";
    if (!values.has(name)) return false;
    let value: string;
    if (arg.includes("=")) value = arg.slice(name.length + 1);
    else {
      if (i >= args.length) return false;
      value = args[i]!;
      i += 1;
    }
    if (!isDigits(value)) return false;
  }
  return true;
};

/** A filter and files: no module loading or reading of filter files, and no environment access. */
export const jqIsSafe = (args: ReadonlyArray<string>): boolean => {
  const refused = new Set([
    "-f",
    "-L",
    "--from-file",
    "--rawfile",
    "--slurpfile",
    "--run-tests",
    "--library-path",
  ]);
  if (args.some((arg) => refused.has(arg.split("=")[0] ?? ""))) return false;
  const filter = args.find((arg) => !arg.startsWith("-")) ?? "";
  return ["env", "ENV", "include", "import", "input_filename", "$__loc__"].every(
    (word) => !filter.includes(word),
  );
};

/** `-v` and `-R` look up variables (with subscripts bash evaluates); the rest only test files and strings. */
export const testIsSafe = (args: ReadonlyArray<string>): boolean =>
  !args.some((arg) => arg === "-v" || arg === "-R") && !args.includes("=~");

/** A sed script made of addresses and the commands p d q Q = l n N g G h H x z D P, s///flags and y///. */
export const sedScriptIsSafe = (script: string): boolean => {
  const c = chars(script);
  let i = 0;
  const isNumber = (ch: string | undefined) => ch !== undefined && /[0-9]/.test(ch);
  const isSpace = isWhitespace;
  const regex = (delimiter: string): boolean => {
    while (i < c.length) {
      if (c[i] === "\\") {
        i += 2;
        continue;
      }
      if (c[i] === delimiter) {
        i += 1;
        return true;
      }
      if (c[i] === "\n") return false;
      i += 1;
    }
    return false;
  };
  const address = (): boolean => {
    if (i < c.length && isNumber(c[i])) {
      while (i < c.length && (isNumber(c[i]) || c[i] === "~")) i += 1;
      return true;
    }
    if (i < c.length && c[i] === "/") {
      i += 1;
      if (!regex("/")) return false;
      while (i < c.length && "IM".includes(c[i]!)) i += 1;
      return true;
    }
    return true;
  };
  while (i < c.length) {
    if (isSpace(c[i]) || c[i] === ";" || c[i] === "}") {
      i += 1;
      continue;
    }
    if (!address()) return false;
    if (i < c.length && c[i] === ",") {
      i += 1;
      if (!address()) return false;
    }
    while (i < c.length && (c[i] === " " || c[i] === "!")) i += 1;
    if (i >= c.length) return false;
    const command = c[i]!;
    i += 1;
    switch (command) {
      case "p":
      case "d":
      case "q":
      case "Q":
      case "=":
      case "l":
      case "n":
      case "N":
      case "g":
      case "G":
      case "h":
      case "H":
      case "x":
      case "z":
      case "D":
      case "P":
      case "{":
        while (i < c.length && isNumber(c[i])) i += 1; // `q5`, `l 40`
        break;
      case "s":
      case "y": {
        if (i >= c.length || isSpace(c[i]) || c[i] === "\\" || c[i] === "\n") return false;
        const delimiter = c[i]!;
        i += 1;
        if (!regex(delimiter) || !regex(delimiter)) return false;
        if (command === "s") while (i < c.length && "gpiIm0123456789".includes(c[i]!)) i += 1;
        break;
      }
      default:
        return false;
    }
    if (!(i === c.length || isSpace(c[i]) || c[i] === ";" || c[i] === "}")) return false;
  }
  return true;
};

/** Claude Code's targets for `xargs`: only these, themselves read-only. */
export const XARGS_TARGETS = new Set([
  "echo",
  "printf",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "tail",
]);

/** `xargs` with its listed flags, then a listed target that is read-only with its arguments. */
export const xargsReadOnly = (args: ReadonlyArray<string>): string | undefined => {
  const table = tableFor("xargs");
  if (table === undefined) return undefined;
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") {
    const name = args[i]!.split("=")[0]!;
    const kind = lookup(table, name);
    if (kind === undefined) return undefined;
    i += kind === "none" || args[i]!.includes("=") ? 1 : 2;
  }
  if (i < args.length && args[i] === "--") i += 1;
  if (!flagsAllowed(args.slice(0, Math.min(i, args.length)), table, "xargs")) return undefined;
  if (i >= args.length) return "xargs";
  if (!XARGS_TARGETS.has(args[i]!)) return undefined;
  const target = readOnlyName(args.slice(i));
  return target === undefined ? undefined : `xargs ${target}`;
};

/** Read-only sed: the table's flags (no `-i`, no `-f`), and printing scripts only (no `w`, `e`, `r`). */
export const sedIsSafe = (args: ReadonlyArray<string>): boolean => {
  const scripts: Array<string> = [];
  let i = 0;
  let first: string | undefined;
  while (i < args.length) {
    const arg = args[i]!;
    i += 1;
    if (arg === "-e" || arg === "--expression") {
      if (i < args.length) {
        scripts.push(args[i]!);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice(13));
      continue;
    }
    if (arg === "-l" || arg === "--line-length") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") continue;
    if (first === undefined) first = arg;
  }
  if (scripts.length === 0 && first !== undefined) scripts.push(first);
  return scripts.length > 0 && scripts.every(sedScriptIsSafe);
};

/** The table for `git <sub>` (or `git config --get`, `git stash list`…): the longest key the words start with. */
const subTable = (
  prefix: string,
  args: ReadonlyArray<string>,
): { readonly name: string; readonly rest: Array<string>; readonly table: Table } | undefined => {
  for (let count = Math.min(2, args.length); count >= 1; count -= 1) {
    const name = [prefix, ...args.slice(0, count)].join(" ");
    const table = tableFor(name);
    if (table !== undefined) return { name, rest: args.slice(count), table };
  }
  return undefined;
};

/** `~user` expansions, and `~` with braces: they read outside what the command names. */
const tilde = (args: ReadonlyArray<string>): boolean =>
  args.some((arg) => /(^|[=:])~/.test(arg) || (arg.includes("~") && arg.includes("{")));

const GIT_BUILT_IN_FORMATS = new Set([
  "oneline",
  "short",
  "medium",
  "full",
  "fuller",
  "email",
  "raw",
  "reference",
  "mboxrd",
]);

/** git formats that run gpg (`%G…`, `%(signature)`), and `--pretty` names from config. */
const gitFormatDanger = (args: ReadonlyArray<string>): boolean => {
  for (const [i, arg] of args.entries()) {
    if (/%[-+ ]?G|%\(\*?signature/.test(arg)) return true;
    for (const flag of ["--format", "--pretty", "--sort", "--group"]) {
      let value: string | undefined;
      if (arg === flag && i + 1 < args.length) value = args[i + 1];
      else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
      if (value === undefined) continue;
      if (tilde([value]) || value.includes("signature")) return true;
      if (
        (flag === "--format" || flag === "--pretty") &&
        value !== "" &&
        !value.includes("%") &&
        !value.startsWith("format:") &&
        !value.startsWith("tformat:") &&
        !GIT_BUILT_IN_FORMATS.has(value)
      )
        return true;
    }
  }
  return false;
};

/** Only `--no-pager` before the subcommand: `-c`, `-C`, `--git-dir` and the rest change what runs or where. */
export const gitReadOnly = (input: ReadonlyArray<string>): string | undefined => {
  const args = [...input];
  while (args[0] === "--no-pager") args.shift();
  const sub = args[0];
  if (sub === undefined || sub.startsWith("-") || tilde(args) || gitFormatDanger(args))
    return undefined;
  const found = subTable("git", args);
  if (found === undefined || !flagsAllowed(found.rest, found.table, "git")) return undefined;
  const { name, rest, table } = found;
  switch (name) {
    case "git remote":
      return rest.every((arg) => arg === "-v" || arg === "--verbose") ? name : undefined;
    case "git remote show": {
      // One remote, named plainly, with `-n` (no network).
      const split = rest.indexOf("--");
      const before = split < 0 ? rest : rest.slice(0, split);
      const after = split < 0 ? [] : rest.slice(split + 1);
      const names = [...before.filter((arg) => arg !== "-n"), ...after];
      if (
        names.length !== 1 ||
        !before.includes("-n") ||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(names[0]!)
      )
        return undefined;
      return name;
    }
    case "git reflog": {
      const verb = rest[0];
      if (verb !== undefined && !verb.startsWith("-") && verb !== "show" && verb !== "list")
        return undefined;
      return rest.some((arg) => ["expire", "delete", "exists", "drop", "write"].includes(arg))
        ? undefined
        : name;
    }
    case "git branch":
    case "git tag": {
      // A name without `--list` (or `-l` in a cluster) creates one; these flags' values are revisions.
      const takesValue = new Set(
        name === "git tag"
          ? [
              "--contains",
              "--no-contains",
              "--merged",
              "--no-merged",
              "--points-at",
              "--sort",
              "--format",
              "-n",
            ]
          : ["--contains", "--no-contains", "--points-at", "--sort", "--merged", "--no-merged"],
      );
      let listing = false;
      let i = 0;
      let after = false;
      while (i < rest.length) {
        const arg = rest[i]!;
        if (arg === "--" && !after) {
          after = true;
          i += 1;
          continue;
        }
        if (!after && arg.startsWith("-")) {
          if (
            arg === "--list" ||
            arg === "-l" ||
            (!arg.startsWith("--") &&
              count(arg) > 2 &&
              !arg.includes("=") &&
              arg.slice(1).includes("l"))
          )
            listing = true;
          // `--merged` takes an optional revision on branch: one that follows is that revision.
          i += arg.includes("=")
            ? 1
            : takesValue.has(arg) && i + 1 < rest.length && !rest[i + 1]!.startsWith("-")
              ? 2
              : 1;
        } else {
          if (!listing) return undefined;
          i += 1;
        }
      }
      return name;
    }
    case "git ls-remote": {
      // No remote named: only the configured one. A value flag's value isn't a remote.
      let i = 0;
      while (i < rest.length) {
        const arg = rest[i]!;
        if (!arg.startsWith("-")) return undefined;
        const kind = lookup(table, arg);
        i += !arg.includes("=") && kind !== undefined && kind !== "none" ? 2 : 1;
      }
      return name;
    }
    default:
      return name;
  }
};

/** gh views, without a value that points elsewhere (`host/owner/repo`, a URL, `user@host`). */
export const ghReadOnly = (args: ReadonlyArray<string>): string | undefined => {
  const found = subTable("gh", args);
  if (
    found === undefined ||
    found.name.split(" ").length !== 3 ||
    !flagsAllowed(found.rest, found.table, "gh")
  )
    return undefined;
  for (const arg of found.rest) {
    let value = arg;
    if (arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      if (equals < 0) continue;
      value = arg.slice(equals + 1);
    }
    if (value.includes("://") || value.includes("@") || value.split("/").length - 1 >= 2)
      return undefined;
  }
  return found.name;
};

const DOCKER_HOST_FLAGS = [
  "-H",
  "-c",
  "-r",
  "--host",
  "--context",
  "--config",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
  "--url",
  "--connection",
  "--identity",
  "--remote",
  "--module",
  "--out",
];

/** `docker logs` and `docker inspect`, without options that pick another daemon. */
export const dockerReadOnly = (args: ReadonlyArray<string>): string | undefined => {
  const found = subTable("docker", args);
  if (found === undefined || !flagsAllowed(found.rest, found.table, "docker") || tilde(found.rest))
    return undefined;
  const letters = new Set(
    DOCKER_HOST_FLAGS.filter((flag) => flag.length === 2).map((flag) => flag[1]!),
  );
  for (const arg of found.rest) {
    if (
      DOCKER_HOST_FLAGS.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && count(arg) > 2 && arg.startsWith(flag)),
      )
    )
      return undefined;
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      const cluster: Array<string> = [];
      for (const c of chars(arg).slice(1)) {
        if (!/\p{L}/u.test(c)) break;
        cluster.push(c);
      }
      if (cluster.length >= 2 && cluster.some((c) => letters.has(c))) return undefined;
    }
  }
  return found.name;
};
