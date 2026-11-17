// @effect-diagnostics nodeBuiltinImport:off - Whole-file reads and writes of lastdrop's own catalog.
/**
 * Reading, validating and saving the fork's agent list (`agents.json`, the standalone app's catalog
 * format, so `parseCatalog` keeps reading it). A save replaces the whole file through a temporary
 * file, and keeps every key the editor does not know (`judges`, `saveClaude`, an agent's extras).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AGENT_PROVIDERS,
  EFFORT_RANK,
  isProvider,
  isReserved,
  type AgentProvider,
} from "./catalog.ts";
import type { CatalogFiles } from "./catalogSource.ts";

export interface AgentEntry {
  readonly provider: AgentProvider;
  readonly model: string;
  readonly effort?: string;
}

/** An agent as the editor lists it: its own provider and model first, then its fallbacks in order. */
export interface AgentRecord extends AgentEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly fallbacks: ReadonlyArray<AgentEntry>;
  /** Ids from the clients' lists (`client-runtime/src/extensions.ts`); absent is the plain look. */
  readonly icon?: string;
  readonly color?: string;
}

const MAX_AGENTS = 64;
/** `catalogFacts` looks at the first eight entries of a chain. */
const MAX_FALLBACKS = 7;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MODEL = /^[^\s\u0000-\u001f]{1,200}$/;
/** An icon or color id. The server keeps any well-formed one; a client that doesn't know it draws the default. */
const LOOK_ID = /^[a-z0-9-]{1,32}$/;

/** The agent's icon and color from a request or the file, each kept only when well-formed. */
const lookOf = (raw: Record<string, unknown>): Pick<AgentRecord, "icon" | "color"> => ({
  ...(typeof raw.icon === "string" && LOOK_ID.test(raw.icon) ? { icon: raw.icon } : {}),
  ...(typeof raw.color === "string" && LOOK_ID.test(raw.color) ? { color: raw.color } : {}),
});

export type Validated =
  | { readonly ok: true; readonly agents: ReadonlyArray<AgentRecord> }
  | { readonly ok: false; readonly error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const entryOf = (raw: unknown, where: string): AgentEntry | string => {
  if (!isRecord(raw)) return `${where} is not an object.`;
  if (!isProvider(raw.provider)) {
    return `${where} needs a provider (${AGENT_PROVIDERS.join(", ")}).`;
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!MODEL.test(model)) return `${where} needs a model, with no spaces.`;
  const effort = typeof raw.effort === "string" ? raw.effort.trim() : "";
  if (effort !== "" && !(EFFORT_RANK as ReadonlyArray<string>).includes(effort)) {
    return `${where} has an unknown effort "${effort}".`;
  }
  return { provider: raw.provider, model, ...(effort === "" ? {} : { effort }) };
};

/** The editor's list from a request body, or why it was refused. */
export const validateAgents = (input: unknown): Validated => {
  if (!Array.isArray(input)) return { ok: false, error: "agents must be a list." };
  if (input.length > MAX_AGENTS) return { ok: false, error: `At most ${MAX_AGENTS} agents.` };
  const names = new Set<string>();
  const ids = new Set<string>();
  const agents: Array<AgentRecord> = [];
  for (const [index, raw] of input.entries()) {
    const where = `Agent ${index + 1}`;
    if (!isRecord(raw)) return { ok: false, error: `${where} is not an object.` };
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!NAME.test(name)) {
      return {
        ok: false,
        error: `${where} needs a name of letters, digits, "-", "_" or "." (up to 48).`,
      };
    }
    if (isReserved(name)) {
      return { ok: false, error: `"${name}" is a name Claude Code keeps for its own models.` };
    }
    if (names.has(name.toLowerCase())) {
      return { ok: false, error: `Two agents are named "${name}".` };
    }
    names.add(name.toLowerCase());
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (description.length > 1000) {
      return { ok: false, error: `"${name}": the description is over 1000 characters.` };
    }
    const first = entryOf(raw, `"${name}"`);
    if (typeof first === "string") return { ok: false, error: first };
    const rawFallbacks: ReadonlyArray<unknown> = Array.isArray(raw.fallbacks) ? raw.fallbacks : [];
    if (rawFallbacks.length > MAX_FALLBACKS) {
      return { ok: false, error: `"${name}": at most ${MAX_FALLBACKS} fallbacks.` };
    }
    const fallbacks: Array<AgentEntry> = [];
    for (const [at, entry] of rawFallbacks.entries()) {
      const parsed = entryOf(entry, `"${name}", fallback ${at + 1}`);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      fallbacks.push(parsed);
    }
    const given = typeof raw.id === "string" ? raw.id.trim() : "";
    const id = given !== "" && !ids.has(given) ? given : NodeCrypto.randomUUID().toUpperCase();
    ids.add(id);
    agents.push({
      id,
      name,
      description,
      enabled: raw.enabled === true,
      ...first,
      fallbacks,
      ...lookOf(raw),
    });
  }
  return { ok: true, agents };
};

export interface CatalogDocument {
  readonly agents: ReadonlyArray<AgentRecord>;
  /** The file's own counter, bumped by each save; the plugin compares it. */
  readonly revision: number;
}

const readDocument = (file: string): Record<string, unknown> | undefined => {
  try {
    const json: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    return isRecord(json) ? json : undefined;
  } catch {
    return undefined;
  }
};

/** An agent of the file as the editor lists it; left out when it has no name, provider or model. */
const recordOf = (raw: unknown): AgentRecord | undefined => {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") return undefined;
  const first = entryOf(raw, raw.name);
  if (typeof first === "string") return undefined;
  const fallbacks = (Array.isArray(raw.fallbacks) ? raw.fallbacks : []).flatMap(
    (entry: unknown) => {
      const parsed = entryOf(entry, raw.name as string);
      return typeof parsed === "string" ? [] : [parsed];
    },
  );
  return {
    id:
      typeof raw.id === "string" && raw.id !== "" ? raw.id : NodeCrypto.randomUUID().toUpperCase(),
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    enabled: raw.enabled === true,
    ...first,
    fallbacks,
    ...lookOf(raw),
  };
};

/** Why the file cannot be edited: it exists but is not a JSON object. Absent is fine (no agents yet). */
export const catalogProblem = (files: CatalogFiles): string | undefined => {
  let text: string;
  try {
    text = NodeFS.readFileSync(files.catalog, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? undefined
      : `${files.catalog} can't be read.`;
  }
  try {
    return isRecord(JSON.parse(text)) ? undefined : `${files.catalog} isn't a JSON object.`;
  } catch {
    return `${files.catalog} isn't valid JSON. Fix or remove it, then reload.`;
  }
};

export const readCatalogDocument = (files: CatalogFiles): CatalogDocument => {
  const doc = readDocument(files.catalog);
  const raw: ReadonlyArray<unknown> = Array.isArray(doc?.agents) ? doc.agents : [];
  return {
    agents: raw.flatMap((agent) => {
      const record = recordOf(agent);
      return record === undefined ? [] : [record];
    }),
    revision: typeof doc?.revision === "number" ? doc.revision : 0,
  };
};

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
const writeWhole = (file: string, contents: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, contents, { mode: 0o600 });
    NodeFS.renameSync(temporary, file);
  } catch (error) {
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
};

const entryJson = (entry: AgentEntry) => ({
  provider: entry.provider,
  model: entry.model,
  ...(entry.effort === undefined ? {} : { effort: entry.effort }),
});

/**
 * Replaces the file's agents with `agents`, bumping `revision`. Keys of an agent that stay with its
 * id, and every other key of the file, are kept as they were.
 */
export const saveCatalog = (files: CatalogFiles, agents: ReadonlyArray<AgentRecord>): number => {
  const doc = readDocument(files.catalog) ?? {};
  const before = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(doc.agents) ? doc.agents : []) {
    if (isRecord(raw) && typeof raw.id === "string") before.set(raw.id, raw);
  }
  const revision = (typeof doc.revision === "number" ? doc.revision : 0) + 1;
  const written = agents.map((agent) => {
    const {
      effort: _effort,
      fallbacks: _fallbacks,
      icon: _icon,
      color: _color,
      ...rest
    } = before.get(agent.id) ?? {};
    return {
      ...rest,
      id: agent.id,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled,
      ...entryJson(agent),
      ...(agent.fallbacks.length === 0 ? {} : { fallbacks: agent.fallbacks.map(entryJson) }),
      ...(agent.icon === undefined ? {} : { icon: agent.icon }),
      ...(agent.color === undefined ? {} : { color: agent.color }),
    };
  });
  writeWhole(files.catalog, `${JSON.stringify({ ...doc, agents: written, revision }, null, 2)}\n`);
  return revision;
};

/** The standalone app's catalog files, for the one-time import: the only code that names its folder. */
export const appCatalogFiles = (home: string): CatalogFiles => {
  const support = NodePath.join(home, "Library", "Application Support", "lastdrop");
  return {
    catalog: NodePath.join(support, "agent-catalog.json"),
    models: NodePath.join(support, "agent-models.json"),
  };
};

/** The app's catalog when it has agents to copy: its file read, never written. */
const appCatalogToImport = (app: CatalogFiles): string | undefined => {
  try {
    const text = NodeFS.readFileSync(app.catalog, "utf8");
    const json: unknown = JSON.parse(text);
    return isRecord(json) && Array.isArray(json.agents) && json.agents.length > 0
      ? text
      : undefined;
  } catch {
    return undefined;
  }
};

/** True while the fork has no agents and the app's catalog has some. */
export const canImportFromApp = (files: CatalogFiles, app: CatalogFiles): boolean =>
  readCatalogDocument(files).agents.length === 0 && appCatalogToImport(app) !== undefined;

/**
 * Copies the app's catalog, and its model efforts when the fork has none, into the fork's files.
 * Returns false when the fork already has agents or the app has nothing to copy. Never writes to `app`.
 */
export const importFromApp = (files: CatalogFiles, app: CatalogFiles): boolean => {
  if (!canImportFromApp(files, app)) return false;
  const catalog = appCatalogToImport(app);
  if (catalog === undefined) return false;
  writeWhole(files.catalog, catalog);
  try {
    if (!NodeFS.existsSync(files.models)) {
      const models = NodeFS.readFileSync(app.models, "utf8");
      JSON.parse(models);
      writeWhole(files.models, models);
    }
  } catch {
    // The efforts are a cache the editor falls back from: the catalog alone is a complete import.
  }
  return true;
};
