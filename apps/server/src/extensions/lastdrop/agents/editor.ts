// @effect-diagnostics nodeBuiltinImport:off - The real home folder (for the one-time import) and the catalog's files.
/**
 * The agents editor's service: the list for Settings (agents, the providers and models to choose
 * from, whether the app's list can be imported), saving it, and the one-time import. Routes stay thin
 * (`editorRoutes.ts`); the files and their validation are `catalogEdit.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, type ServerProviderModel } from "@t3tools/contracts";

import { resolveLastdropDataDir } from "../../dataDir.ts";
import {
  AGENT_PROVIDERS,
  CALLER_EFFORTS,
  DEFAULT_INSTANCES,
  PROVIDER_LABEL,
  parseModelEfforts,
  reasoningDescriptor,
  type AgentProvider,
  type ModelEfforts,
} from "./catalog.ts";
import {
  appCatalogFiles,
  canImportFromApp,
  catalogProblem,
  importFromApp,
  readCatalogDocument,
  saveCatalog,
  validateAgents,
  type AgentRecord,
} from "./catalogEdit.ts";
import { agentCatalogFiles, type CatalogFiles } from "./catalogSource.ts";
import * as Shared from "./shared.ts";

export interface ModelChoice {
  readonly id: string;
  readonly name: string;
  /** The efforts the model takes; empty when it takes none. */
  readonly efforts: ReadonlyArray<string>;
}

export interface ProviderChoice {
  readonly provider: AgentProvider;
  readonly label: string;
  /** The T3 instance that runs this provider's entries. */
  readonly instanceId: string;
  /** False while the instance is missing, off or not set up: its entries are skipped at run time. */
  readonly available: boolean;
  readonly models: ReadonlyArray<ModelChoice>;
  /** Efforts for a model typed in by hand. */
  readonly efforts: ReadonlyArray<string>;
}

export interface AgentsView {
  readonly agents: ReadonlyArray<AgentRecord>;
  /** Pass it back with a save: a list changed elsewhere meanwhile is refused. */
  readonly revision: number;
  readonly providers: ReadonlyArray<ProviderChoice>;
  /** The fork has no agents and the standalone app's list exists. */
  readonly canImport: boolean;
  /** Why the list can't be edited, when it can't. */
  readonly problem?: string;
}

export class AgentsEditorError extends Schema.TaggedError<AgentsEditorError>()(
  "LastdropAgentsEditorError",
  { status: Schema.Number, message: Schema.String },
) {}

export interface AgentsEditor {
  readonly view: Effect.Effect<AgentsView>;
  /** Validates and saves `agents` (a request body's list); `revision` is the one the list was read at. */
  readonly save: (input: {
    readonly agents: unknown;
    readonly revision?: unknown;
  }) => Effect.Effect<AgentsView, AgentsEditorError>;
  /** Copies the standalone app's list while the fork has none. */
  readonly importFromApp: Effect.Effect<AgentsView, AgentsEditorError>;
}

export class LastdropAgentsEditor extends Context.Service<LastdropAgentsEditor, AgentsEditor>()(
  "t3/extensions/lastdrop/agents/editor/LastdropAgentsEditor",
) {}

/** The aliases Claude Code takes for its models, offered first. */
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

const readModelEfforts = (file: string): ModelEfforts => {
  try {
    return parseModelEfforts(JSON.parse(NodeFS.readFileSync(file, "utf8")));
  } catch {
    return {};
  }
};

const modelChoice = (
  provider: AgentProvider,
  model: ServerProviderModel,
  known: ModelEfforts,
): ModelChoice => {
  const live = reasoningDescriptor([model], model.slug)?.options.map((option) => option.id);
  return {
    id: model.slug,
    name: model.name,
    efforts: live ?? known[provider]?.find((entry) => entry.id === model.slug)?.efforts ?? [],
  };
};

const providerChoice = (
  provider: AgentProvider,
  models: ReadonlyArray<ServerProviderModel> | undefined,
  known: ModelEfforts,
): ProviderChoice => {
  const listed = (models ?? []).map((model) => modelChoice(provider, model, known));
  const aliases =
    provider === "claude"
      ? CLAUDE_ALIASES.filter((alias) => !listed.some((model) => model.id === alias)).map(
          (alias) => ({ id: alias, name: alias, efforts: CALLER_EFFORTS.claude }),
        )
      : [];
  return {
    provider,
    label: PROVIDER_LABEL[provider],
    instanceId: DEFAULT_INSTANCES[provider],
    available: models !== undefined,
    models: [...aliases, ...listed],
    efforts: CALLER_EFFORTS[provider],
  };
};

export interface AgentsEditorInput {
  readonly files: CatalogFiles;
  /** The standalone app's files for the one-time import; undefined when there is none to offer. */
  readonly app?: CatalogFiles | undefined;
  /** The models an instance publishes; undefined when it is missing, off or not set up. */
  readonly models: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProviderModel> | undefined>;
}

export const makeAgentsEditor = (input: AgentsEditorInput): AgentsEditor => {
  const view: Effect.Effect<AgentsView> = Effect.gen(function* () {
    const known = readModelEfforts(input.files.models);
    const providers = yield* Effect.forEach(AGENT_PROVIDERS, (provider) =>
      input
        .models(ProviderInstanceId.make(DEFAULT_INSTANCES[provider]))
        .pipe(Effect.map((models) => providerChoice(provider, models, known))),
    );
    const problem = catalogProblem(input.files);
    const document = readCatalogDocument(input.files);
    return {
      agents: document.agents,
      revision: document.revision,
      providers,
      canImport:
        problem === undefined &&
        input.app !== undefined &&
        canImportFromApp(input.files, input.app),
      ...(problem === undefined ? {} : { problem }),
    };
  });

  const refuse = (status: number, message: string) =>
    Effect.fail(new AgentsEditorError({ status, message }));

  const save = Effect.fn("LastdropAgentsEditor.save")(function* (body: {
    readonly agents: unknown;
    readonly revision?: unknown;
  }) {
    const problem = catalogProblem(input.files);
    if (problem !== undefined) return yield* refuse(409, problem);
    const checked = validateAgents(body.agents);
    if (!checked.ok) return yield* refuse(400, checked.error);
    const current = readCatalogDocument(input.files).revision;
    if (typeof body.revision === "number" && body.revision !== current) {
      return yield* refuse(409, "The agents changed elsewhere. Reload, then edit again.");
    }
    yield* Effect.try({
      try: () => saveCatalog(input.files, checked.agents),
      catch: (error) => new AgentsEditorError({ status: 500, message: String(error) }),
    });
    return yield* view;
  });

  const importApp = Effect.gen(function* () {
    if (input.app === undefined || !canImportFromApp(input.files, input.app)) {
      return yield* refuse(409, "There is nothing to import: lastdrop already has agents.");
    }
    const app = input.app;
    yield* Effect.try({
      try: () => importFromApp(input.files, app),
      catch: (error) => new AgentsEditorError({ status: 500, message: String(error) }),
    });
    return yield* view;
  });

  return { view, save, importFromApp: importApp };
};

/**
 * Not under vitest: T3's own server tests start this layer, and must not look at the real home folder
 * for the app's list.
 */
export const layer = Layer.effect(
  LastdropAgentsEditor,
  Effect.gen(function* () {
    const underTest = yield* Config.String("VITEST").pipe(Config.option);
    const dataDir = yield* resolveLastdropDataDir;
    return LastdropAgentsEditor.of(
      makeAgentsEditor({
        files: agentCatalogFiles(dataDir),
        app: underTest._tag === "Some" ? undefined : appCatalogFiles(NodeOS.homedir()),
        models: Shared.targets.models,
      }),
    );
  }),
);
