// @effect-diagnostics nodeBuiltinImport:off - Reads and watches two small files of lastdrop's own folder.
/**
 * The catalog the fork keeps: `agents.json` (the standalone app's `agent-catalog.json` format) and
 * `agent-models.json` in `~/.t3/lastdrop/`. The driver polls it every 2 s, so an edit in Settings
 * (or by hand) shows in T3's model list without a restart. A catalog that does not parse keeps the
 * last good reading; one that does not exist yet is an empty list.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  allAgents,
  parseCatalog,
  parseModelEfforts,
  type AgentDefinition,
  type InstanceMap,
  type ModelEfforts,
} from "./catalog.ts";

export interface CatalogFiles {
  readonly catalog: string;
  readonly models: string;
}

export const agentCatalogFiles = (dataDir: string): CatalogFiles => ({
  catalog: NodePath.join(dataDir, "agents.json"),
  models: NodePath.join(dataDir, "agent-models.json"),
});

let boundDir: string | undefined;

/** Called once by `Extensions.layer` with lastdrop's folder; the driver may open before it runs. */
export const bindCatalogDir = (dataDir: string | undefined): void => {
  boundDir = dataDir;
};

/** The server's catalog files; undefined until `Extensions.layer` bound the folder. */
export const boundCatalogFiles = (): CatalogFiles | undefined =>
  boundDir === undefined ? undefined : agentCatalogFiles(boundDir);

export interface CatalogReading {
  /** Claude's own models first, then the catalog's enabled agents. */
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly efforts: ModelEfforts;
  /** Why the catalog could not be read, when it could not. */
  readonly problem?: string;
}

/** A file that does not exist reads as an empty object: no agents yet is not a problem. */
const readJson = (file: string): { readonly value?: unknown; readonly problem?: string } => {
  try {
    return { value: JSON.parse(NodeFS.readFileSync(file, "utf8")) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { value: {} }
      : { problem: `${file}: ${String(error)}` };
  }
};

const stamp = (file: string): string => {
  try {
    const stat = NodeFS.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
};

export interface CatalogSource {
  readonly current: () => CatalogReading;
  /** Reads the files again when either changed; true when it did. */
  readonly reloadIfChanged: () => boolean;
}

export const makeCatalogSource = (input: {
  /** A function is read at each check, for a folder that is bound after the source opened. */
  readonly files: CatalogFiles | (() => CatalogFiles | undefined);
  readonly instances?: InstanceMap;
}): CatalogSource => {
  const filesNow = () => (typeof input.files === "function" ? input.files() : input.files);
  let catalog: ReadonlyArray<AgentDefinition> = [];
  let efforts: ModelEfforts = {};
  let problem: string | undefined;
  let stamps = "";

  const reload = (): boolean => {
    const files = filesNow();
    if (files === undefined) return false;
    const next = `${files.catalog}|${stamp(files.catalog)}|${stamp(files.models)}`;
    if (next === stamps) return false;
    stamps = next;
    const read = readJson(files.catalog);
    if (read.problem === undefined) {
      catalog = parseCatalog(read.value, input.instances);
      problem = undefined;
    } else {
      problem = read.problem;
    }
    const models = readJson(files.models);
    if (models.problem === undefined) efforts = parseModelEfforts(models.value);
    return true;
  };
  reload();

  return {
    current: () => ({
      agents: allAgents(catalog, input.instances),
      efforts,
      ...(problem === undefined ? {} : { problem }),
    }),
    reloadIfChanged: reload,
  };
};
