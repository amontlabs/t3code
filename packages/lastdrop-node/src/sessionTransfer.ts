/**
 * Claude Code transcripts in the shared conversations folder (`~/.claude/projects/<project>/<session>.jsonl`):
 * finding one whatever its project folder, reading its tail to tell a warm conversation from a cold one,
 * bringing one over from an account's own old folder, and reading its message ids across forks. Port of
 * headroom's `SessionTransfer` and `ThreadLauncher.transcript(ofConversation:)`.
 */
import * as NodeFSP from "node:fs/promises";

import {
  COLD,
  parseTail,
  type Transcript,
  type TranscriptIds,
  transcriptIds,
  translateMessageId,
  withoutTrailingNotices,
} from "@t3tools/lastdrop-core";

import { exists, readText } from "./files.ts";

/** Only the tail is read first: a conversation can be megabytes, and only its end says whether it is warm. */
export const TAIL_BYTES = 512 * 1024;
/** How far back an answer is looked for at most. */
export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** Where each session's transcript was found last: a hit is checked, never trusted blindly. */
const found = new Map<string, string>();

/** The session's transcript under `projects`, whatever the project folder. */
export async function findTranscript(
  session: string,
  projects: string,
): Promise<string | undefined> {
  if (session === "") return undefined;
  const key = `${projects}\0${session}`;
  const known = found.get(key);
  if (known !== undefined) {
    if (await exists(known)) return known;
    found.delete(key);
  }
  let names: string[];
  try {
    names = await NodeFSP.readdir(projects);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const file = `${projects}/${name}/${session}.jsonl`;
    if (await exists(file)) {
      if (found.size > 5000) found.clear();
      found.set(key, file);
      return file;
    }
  }
  return undefined;
}

/** A line of the conversation itself (a prompt or an answer), not metadata. */
export function isConversationLine(line: string): boolean {
  if (!line.includes('"type"')) return false;
  try {
    const type = (JSON.parse(line) as { type?: unknown }).type;
    return type === "user" || type === "assistant";
  } catch {
    return false;
  }
}

/**
 * Whether the session's transcript holds a conversation line yet. A fresh id may have no file, or only
 * metadata from a first open that failed: neither has been answered on any account.
 */
export async function hasTranscriptLines(session: string, projects: string): Promise<boolean> {
  const file = await findTranscript(session, projects);
  const text = file === undefined ? undefined : await readText(file);
  return text !== undefined && text.split("\n").some(isConversationLine);
}

async function tail(file: string, bytes: number): Promise<{ text: string; whole: boolean }> {
  const handle = await NodeFSP.open(file, "r");
  try {
    const { size } = await handle.stat();
    const whole = size <= bytes;
    const start = whole ? 0 : size - bytes;
    const length = whole ? size : bytes;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), whole };
  } finally {
    await handle.close();
  }
}

/**
 * What the conversation's transcript says about its end. A missing file counts as cold. A big tool result
 * after the last answer can fill the whole tail: it reads further back, in growing chunks, until an answer
 * shows up or the limit (or the file's start) is reached.
 */
const tails = new Map<string, { size: number; mtimeMs: number; transcript: Transcript }>();

export async function conversationTail(session: string, projects: string): Promise<Transcript> {
  const file = await findTranscript(session, projects);
  if (!file) return COLD;
  // Unchanged since the last read: the same answer, without reading megabytes again.
  const stat = await NodeFSP.stat(file).catch(() => undefined);
  const cached = tails.get(file);
  if (stat && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.transcript;
  }
  const transcript = await readTail(file);
  if (stat) {
    if (tails.size > 1000) tails.clear();
    tails.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, transcript });
  }
  return transcript;
}

async function readTail(file: string): Promise<Transcript> {
  let bytes = TAIL_BYTES;
  for (;;) {
    let read: { text: string; whole: boolean };
    try {
      read = await tail(file, bytes);
    } catch {
      return COLD;
    }
    const parsed = parseTail(read.text);
    if (parsed.lastAssistantAt !== undefined || read.whole || bytes >= MAX_TAIL_BYTES)
      return parsed;
    bytes = Math.min(bytes * 4, MAX_TAIL_BYTES);
  }
}

/**
 * Copies the session's transcript (without its trailing limit notices) and its side folder (long tool results,
 * its subagents) from `source` to `target`, under the same project folder. True once it is there.
 */
export async function copyTranscript(
  session: string,
  source: string,
  target: string,
): Promise<boolean> {
  if (session === "") return false;
  const [realSource, realTarget] = await Promise.all([
    NodeFSP.realpath(source).catch(() => source),
    NodeFSP.realpath(target).catch(() => target),
  ]);
  if (realSource === realTarget) return false;
  const file = await findTranscript(session, source);
  if (!file) return false;
  const text = await readText(file);
  if (text === undefined) return false;
  const project = file.slice(source.length + 1, file.length - `/${session}.jsonl`.length);
  const to = `${target}/${project}`;
  await NodeFSP.mkdir(to, { recursive: true, mode: 0o700 });
  const temp = `${to}/${session}.jsonl.tmp.lastdrop.${process.pid}`;
  await NodeFSP.writeFile(temp, withoutTrailingNotices(text), { mode: 0o600 });
  await NodeFSP.rename(temp, `${to}/${session}.jsonl`);
  const side = `${source}/${project}/${session}`;
  if (await exists(side)) {
    await NodeFSP.rm(`${to}/${session}`, { recursive: true, force: true });
    await NodeFSP.cp(side, `${to}/${session}`, { recursive: true });
  }
  return true;
}

/**
 * Claude Code resumes a subagent (SendMessage to its id) only from `<project>/<session>/subagents/` of the
 * session it runs as, and its `--fork-session` doesn't copy that folder. Copies each source's `subagents/`
 * (newest source first) into `target`'s, beside the first source's transcript, never overwriting a file
 * already there. Sources without a transcript or the folder are skipped. Returns how many were copied from.
 */
export async function copySubagentFolders(
  sources: ReadonlyArray<string>,
  target: string,
  projects: string,
): Promise<number> {
  if (target === "") return 0;
  let into: string | undefined;
  let copied = 0;
  for (const source of sources) {
    if (source === "" || source === target) continue;
    const file = await findTranscript(source, projects);
    if (file === undefined) continue;
    const project = file.slice(0, file.length - `/${source}.jsonl`.length);
    into ??= `${project}/${target}/subagents`;
    const from = `${project}/${source}/subagents`;
    if (!(await exists(from))) continue;
    await NodeFSP.mkdir(into, { recursive: true, mode: 0o700 });
    await NodeFSP.cp(from, into, { recursive: true, force: false, errorOnExist: false });
    copied += 1;
  }
  return copied;
}

/**
 * The session's transcript in the shared folder; one only in an account's own old folder (runs from before
 * conversations were shared) is copied there first. Undefined when none has it.
 */
export async function transcriptInShared(
  session: string,
  shared: string,
  oldFolders: ReadonlyArray<string>,
): Promise<string | undefined> {
  const found = await findTranscript(session, shared);
  if (found) return found;
  for (const old of oldFolders) {
    if (await copyTranscript(session, old, shared)) return findTranscript(session, shared);
  }
  return undefined;
}

/** A transcript's message ids (see `transcriptIds`); undefined when it isn't there. */
export async function transcriptIdsOf(
  session: string,
  projects: string,
): Promise<TranscriptIds | undefined> {
  const file = await findTranscript(session, projects);
  const text = file === undefined ? undefined : await readText(file);
  return text === undefined ? undefined : transcriptIds(text);
}

/**
 * The id message `uuid` (of `session` or of a conversation it was forked from) has in `session`: Claude Code
 * gives copied messages new ids when it forks. Undefined when the lineage doesn't hold it.
 */
export async function messageIdIn(
  uuid: string,
  session: string,
  projects: string,
): Promise<string | undefined> {
  const read = new Map<string, TranscriptIds | undefined>();
  // The pure walk is synchronous: read the lineage first, following each transcript's parent.
  let next: string | undefined = session;
  while (next !== undefined && !read.has(next) && read.size < 17) {
    const ids = await transcriptIdsOf(next, projects);
    read.set(next, ids);
    if (ids === undefined || ids.own.has(uuid) || ids.copies.has(uuid)) break;
    next = ids.parent;
  }
  return translateMessageId(uuid, session, (s) => read.get(s));
}
