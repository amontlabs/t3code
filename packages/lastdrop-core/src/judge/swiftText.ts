/**
 * Swift's text model for the ported checks: characters are grapheme clusters (`"\r\n"` is one, so it
 * never splits a command), and whitespace is Swift's (`Character.isWhitespace`, `.whitespacesAndNewlines`):
 * U+0085 is whitespace, U+FEFF is not. JS's `\s` differs on both, so the checks use these instead.
 */
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The text's characters, as Swift iterates a `String`. */
export const chars = (text: string): Array<string> =>
  Array.from(segmenter.segment(text), (segment) => segment.segment);

/** Unicode White_Space, which Swift's `Character.isWhitespace` tests on the first scalar. */
export const WHITESPACE =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const FIRST_IS_WHITESPACE = new RegExp(`^[${WHITESPACE}]`, "u");

export const isWhitespace = (c: string | undefined): boolean =>
  c !== undefined && FIRST_IS_WHITESPACE.test(c);

/** `trimmingCharacters(in: .whitespacesAndNewlines)`, by characters. */
export const trim = (text: string): string => {
  const list = chars(text);
  let start = 0;
  let end = list.length;
  while (start < end && isWhitespace(list[start])) start += 1;
  while (end > start && isWhitespace(list[end - 1])) end -= 1;
  return list.slice(start, end).join("");
};

/** `split(separator: " ")`: at the character `" "` only, empty pieces dropped. */
export const splitAtSpaces = (text: string): Array<string> => {
  const out: Array<string> = [];
  let current = "";
  for (const c of chars(text)) {
    if (c === " ") {
      if (current !== "") out.push(current);
      current = "";
    } else current += c;
  }
  if (current !== "") out.push(current);
  return out;
};

/** The number of characters, as Swift's `count`. */
export const count = (text: string): number => chars(text).length;
