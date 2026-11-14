// @effect-diagnostics nodeBuiltinImport:off - Reads and watches two small files of the standalone app.
/**
 * The catalog as the standalone lastdrop keeps it, read-only: `agent-catalog.json` and
 * `agent-models.json` in `~/Library/Application Support/lastdrop`. The driver polls it every 2 s
 * (as the standalone ACP provider does), so an edit in the standalone app shows in T3's model
 * list without a restart. A catalog that does not parse keeps the last good reading.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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

export const standaloneCatalogFiles = (home: string = NodeOS.homedir()): CatalogFiles => {
  const support = NodePath.join(home, "Library", "Application Support", "lastdrop");
  return {
    catalog: NodePath.join(support, "agent-catalog.json"),
    models: NodePath.join(support, "agent-models.json"),
  };
};

export interface CatalogReading {
  /** Claude's own models first, then the catalog's enabled agents. */
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly efforts: ModelEfforts;
  /** Why the catalog could not be read, when it could not. */
  readonly problem?: string;
}

const readJson = (file: string): { readonly value?: unknown; readonly problem?: string } => {
  try {
    return { value: JSON.parse(NodeFS.readFileSync(file, "utf8")) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: code === "ENOENT" ? `${file} does not exist.` : `${file}: ${String(error)}` };
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
  readonly files: CatalogFiles;
  readonly instances?: InstanceMap;
}): CatalogSource => {
  let catalog: ReadonlyArray<AgentDefinition> = [];
  let efforts: ModelEfforts = {};
  let problem: string | undefined;
  let stamps = "";

  const reload = (): boolean => {
    const next = `${stamp(input.files.catalog)}|${stamp(input.files.models)}`;
    if (next === stamps) return false;
    stamps = next;
    const read = readJson(input.files.catalog);
    if (read.problem === undefined) {
      catalog = parseCatalog(read.value, input.instances);
      problem = undefined;
    } else {
      problem = read.problem;
    }
    const models = readJson(input.files.models);
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
