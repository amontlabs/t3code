/**
 * The user's Claude Code `Bash(...)` rules on another provider's command (headroom `PermissionRules.swift`).
 * Deny and ask match any part; allow needs every part understood and covered, else the judge decides.
 * lastdrop-node's `loadPermissionRules` reads the settings files.
 */

/** `Bash(...)` specifiers; `*` stands for a bare `Bash` rule. */
export interface PermissionRules {
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
  readonly ask: ReadonlyArray<string>;
}

export type RulesVerdict =
  /** Every part of the command matches one of these allow rules. */
  | { readonly type: "allow"; readonly rules: ReadonlyArray<string> }
  | { readonly type: "deny"; readonly rule: string }
  /** An ask rule matches: the user wants to be asked, and nobody is asked here. */
  | { readonly type: "ask"; readonly rule: string }
  /** The rules don't decide. */
  | { readonly type: "none" };

export const EMPTY_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

const isWhitespace = (c: string | undefined): boolean => c !== undefined && /\s/u.test(c);
const trim = (text: string): string => text.replace(/^\s+|\s+$/gu, "");
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `Bash` → `*`; `Bash(npm test:*)` → `npm test:*`; other tools and parameter rules (`Bash(timeout:5)`) → undefined. */
export const bashSpecifier = (rule: string): string | undefined => {
  const trimmed = rule.replace(/^[ \t]+|[ \t]+$/g, "");
  if (trimmed === "Bash") return "*";
  if (!trimmed.startsWith("Bash(") || !trimmed.endsWith(")")) return undefined;
  const spec = trimmed.slice(5, -1);
  const parameters = [
    "run_in_background",
    "timeout",
    "description",
    "dangerouslyDisableSandbox",
    "command",
  ];
  const colon = spec.indexOf(":");
  if (colon >= 0 && parameters.includes(spec.slice(0, colon).replace(/^[ \t]+|[ \t]+$/g, "")))
    return undefined;
  return spec === "" ? undefined : spec;
};

/** Adds a settings file's `permissions` object; duplicates are kept once, first file first. */
export const addPermissions = (rules: PermissionRules, permissions: unknown): PermissionRules => {
  const object =
    typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)
      ? (permissions as Record<string, unknown>)
      : {};
  const bash = (key: string): Array<string> => {
    const list = object[key];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) return [];
    return list.flatMap((entry) => {
      const spec = bashSpecifier(entry);
      return spec === undefined ? [] : [spec];
    });
  };
  const merge = (current: ReadonlyArray<string>, added: Array<string>) => {
    const out = [...current];
    for (const rule of added) if (!out.includes(rule)) out.push(rule);
    return out;
  };
  return {
    allow: merge(rules.allow, bash("allow")),
    deny: merge(rules.deny, bash("deny")),
    ask: merge(rules.ask, bash("ask")),
  };
};

export const checkRules = (rules: PermissionRules, input: string): RulesVerdict => {
  const command = trim(input);
  if (command === "") return { type: "none" };
  // Deny and ask see every piece, including those inside substitutions, subshells and loops.
  const pieces = splitCommand(command, true)?.map((part) => unwrapCommand(part, false).text) ?? [
    command,
  ];
  for (const rule of rules.deny)
    if (pieces.some((piece) => matchesRule(rule, piece)))
      return { type: "deny", rule: `Bash(${rule})` };
  for (const rule of rules.ask)
    if (pieces.some((piece) => matchesRule(rule, piece)))
      return { type: "ask", rule: `Bash(${rule})` };
  // Allow needs a command lastdrop fully understands, every part of it covered.
  if (rules.allow.length === 0) return { type: "none" };
  const parts = splitCommand(command, false);
  if (parts === undefined) return { type: "none" };
  const used: Array<string> = [];
  for (const part of parts) {
    const unwrapped = unwrapCommand(part, true);
    if (unwrapped.blocked || redirects(unwrapped.text)) return { type: "none" };
    const exact = needsExactRule(unwrapped.text);
    const rule = rules.allow.find((candidate) =>
      exact
        ? !candidate.includes("*") && !unwrapped.text.includes("*") && candidate === unwrapped.text
        : matchesRule(candidate, unwrapped.text),
    );
    if (rule === undefined) return { type: "none" };
    if (!used.includes(`Bash(${rule})`)) used.push(`Bash(${rule})`);
  }
  return { type: "allow", rules: used };
};

/**
 * Claude Code's wildcard: `*` matches any text; `:*` at the end means ` *`; a trailing ` *` that is
 * the only wildcard also matches the bare command.
 */
export const matchesRule = (input: string, command: string): boolean => {
  let rule = input;
  if (rule.endsWith(":*")) rule = `${rule.slice(0, -2)} *`;
  if (rule === "*") return true;
  const parts = rule.split("*");
  if (parts.length === 1) return rule === command;
  if (parts.length === 2 && rule.endsWith(" *") && command === rule.slice(0, -2)) return true;
  return new RegExp(`^${parts.map(escapeRegex).join(".*")}$`, "su").test(command);
};

const LOOSE_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "time",
  "case",
  "esac",
]);
const FLOW = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "function",
  "select",
]);

/**
 * The command's parts, split at `&&`, `||`, `;`, `|`, `|&`, `&` and newlines outside quotes. Strict
 * (`loose` false) gives undefined for anything it doesn't fully understand: substitutions, subshells,
 * groups, here-docs, control flow, unbalanced quotes, a dangling operator. Loose also splits at
 * those, for deny rules.
 */
export const splitCommand = (command: string, loose: boolean): Array<string> | undefined => {
  const parts: Array<string> = [];
  let current = "";
  let single = false;
  let double = false;
  let escaped = false;
  let dangling = false;
  const chars = Array.from(command);
  let i = 0;
  const cut = () => {
    const part = trim(current);
    current = "";
    if (part !== "") parts.push(part);
  };
  while (i < chars.length) {
    const c = chars[i]!;
    const next = chars[i + 1];
    if (escaped) {
      current += c;
      escaped = false;
      i += 1;
      continue;
    }
    if (single) {
      current += c;
      if (c === "'") single = false;
      i += 1;
      continue;
    }
    if (c === "\\") {
      current += c;
      escaped = true;
      i += 1;
      continue;
    }
    if (double) {
      if (c === '"') {
        double = false;
        current += c;
        i += 1;
        continue;
      }
      if (c === "`" || (c === "$" && next === "(")) {
        if (!loose) return undefined;
        cut();
        i += c === "`" ? 1 : 2;
        continue;
      }
      current += c;
      i += 1;
      continue;
    }
    if (c === "'") {
      single = true;
      current += c;
      i += 1;
    } else if (c === '"') {
      double = true;
      current += c;
      i += 1;
    } else if (
      (c === "&" && next === "&") ||
      (c === "|" && next === "|") ||
      (c === "|" && next === "&")
    ) {
      cut();
      dangling = true;
      i += 2;
    } else if (
      (c === "&" && next === ">") ||
      (c === ">" && next === "&") ||
      (c === "<" && next === "&")
    ) {
      // `&>file`, `2>&1`, `<&3`: redirections, not separators.
      current += c + next;
      i += 2;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      dangling = c === "|";
      cut();
      i += 1;
    } else if (c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      if (!loose) return undefined;
      cut();
      i += 1;
    } else if (c === "$" && next === "(") {
      if (!loose) return undefined;
      cut();
      i += 2;
    } else if (c === "<" && next === "<") {
      if (!loose) return undefined;
      current += c;
      i += 1;
    } else {
      if (!isWhitespace(c)) dangling = false;
      current += c;
      i += 1;
    }
  }
  if (single || double || escaped) return loose ? [...parts, current] : undefined;
  if (!loose && dangling) return undefined;
  cut();
  if (loose) {
    // Control-flow words in front of a command (`for … do rm x; done`) aren't the command.
    return parts
      .map((part) => {
        const words = part.split(" ").filter((word) => word !== "");
        while (words.length > 0 && LOOSE_KEYWORDS.has(words[0]!)) words.shift();
        return words.join(" ");
      })
      .filter((part) => part !== "");
  }
  // Control flow can't be judged part by part.
  if (parts.some((part) => FLOW.has(part.split(" ")[0] ?? ""))) return undefined;
  return parts;
};

interface Word {
  readonly text: string;
  /** Code-unit offset in the part. */
  readonly start: number;
}

/** Words of a part, split at unquoted whitespace, with where each starts. */
export const shellWords = (part: string): Array<Word> => {
  const words: Array<Word> = [];
  let current = "";
  let start: number | undefined;
  let single = false;
  let double = false;
  let escaped = false;
  let index = 0;
  for (const c of part) {
    if (!single && !double && !escaped && isWhitespace(c)) {
      if (start !== undefined) {
        words.push({ text: current, start });
        current = "";
        start = undefined;
      }
    } else {
      if (start === undefined) start = index;
      if (escaped) escaped = false;
      else if (c === "\\" && !single) escaped = true;
      else if (c === "'" && !double) single = !single;
      else if (c === '"' && !single) double = !double;
      current += c;
    }
    index += c.length;
  }
  if (start !== undefined) words.push({ text: current, start });
  return words;
};

/**
 * A part with Claude Code's wrappers and leading variable assignments removed. For allow, any
 * assignment blocks the part (lastdrop doesn't know Claude Code's list of safe variables).
 */
export const unwrapCommand = (
  part: string,
  forAllow: boolean,
): { readonly text: string; readonly blocked: boolean } => {
  const words = shellWords(part);
  let blocked = false;
  const drop = (n: number) => words.splice(0, Math.min(n, words.length));
  let changed = true;
  while (changed && words.length > 0) {
    const first = words[0]!.text;
    changed = true;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first)) {
      if (forAllow) blocked = true;
      drop(1);
    } else if (first === "nohup" || first === "builtin" || first === "noglob") {
      drop(1);
    } else if (first === "command" && words.length > 1 && !["-v", "-V"].includes(words[1]!.text)) {
      drop(1);
    } else if (first === "xargs" && words.length > 1 && !words[1]!.text.startsWith("-")) {
      drop(1);
    } else if (first === "time") {
      drop(words.length > 1 && words[1]!.text === "-p" ? 2 : 1);
    } else if (first === "nice") {
      if (words.length > 2 && words[1]!.text === "-n") drop(3);
      else if (words.length > 1 && /^-\d+$/.test(words[1]!.text)) drop(2);
      else drop(1);
    } else if (first === "timeout") {
      drop(1);
      while (words.length > 0 && words[0]!.text.startsWith("-")) {
        const flag = words[0]!.text;
        drop(["-s", "-k", "--signal", "--kill-after"].includes(flag) ? 2 : 1);
      }
      drop(1); // the duration
    } else if (first === "stdbuf") {
      drop(1);
      while (words.length > 0 && words[0]!.text.startsWith("-")) {
        const flag = words[0]!.text;
        drop(["-i", "-o", "-e"].includes(flag) ? 2 : 1);
      }
    } else {
      changed = false;
    }
  }
  if (words.length === 0) return { text: "", blocked };
  return { text: trim(part.slice(words[0]!.start)), blocked };
};

/** An unquoted redirection whose target is a file: the command's rule doesn't cover writing or reading it. */
export const redirects = (part: string): boolean => {
  let single = false;
  let double = false;
  let escaped = false;
  let stripped = "";
  for (const c of part) {
    if (escaped) {
      escaped = false;
      stripped += "_";
      continue;
    }
    if (c === "\\" && !single) {
      escaped = true;
      stripped += "_";
      continue;
    }
    if (c === "'" && !double) {
      single = !single;
      stripped += "_";
      continue;
    }
    if (c === '"' && !single) {
      double = !double;
      stripped += "_";
      continue;
    }
    stripped += single || double ? "_" : c;
  }
  // Harmless targets: /dev/null and file descriptors.
  const rest = stripped.replace(/(\d*|&)>>?\s*\/dev\/null|\d*>&\d+|<&\d+/g, " ");
  return rest.includes(">") || rest.includes("<");
};

const FIND_WRITE_ACTIONS = new Set([
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

/** Exec wrappers and `find` with an action that runs, deletes or writes: only an exact rule can allow them. */
export const needsExactRule = (command: string): boolean => {
  const words = shellWords(command).map((word) => word.text);
  const first = words[0];
  if (first === undefined) return false;
  if (["watch", "setsid", "ionice", "flock"].includes(first)) return true;
  return first === "find" && words.some((word) => FIND_WRITE_ACTIONS.has(word));
};
