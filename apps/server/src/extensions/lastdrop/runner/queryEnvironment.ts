// @effect-diagnostics nodeBuiltinImport:off - Reads a settings file a query names by path.
/**
 * Every Claude query the fork opens carries the runner's variables (`endpoint.ts`) and loads lastdrop's own
 * copy of its plugin, so that Claude Code answers its Agent types through the fork. Applied around the routing wrapper
 * (`queryRunnerLive.ts`), on every Claude instance (Z.ai and OpenRouter too: the variables pick no
 * account and change no endpoint), and only once the runner routes are bound.
 */
import * as NodeFS from "node:fs";

import { APP_PLUGIN_ID } from "@t3tools/lastdrop-node";

import { runnerEnvironment } from "./endpoint.ts";

interface OpenInput {
  readonly threadId: string;
  readonly options: { readonly env?: Readonly<Record<string, string | undefined>> | undefined };
}

/** The open input with the thread's runner variables in its environment; unchanged while unbound. */
export const withRunnerEnvironment = <I extends OpenInput>(
  input: I,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  variables: (threadId: string) => Record<string, string> | undefined = runnerEnvironment,
): I => {
  const added = variables(input.threadId);
  if (added === undefined) return input;
  // As the SDK reads it: the query's own environment, else the server's.
  const base = input.options.env ?? hostEnvironment;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  return { ...input, options: { ...input.options, env: { ...env, ...added } } };
};

interface PluginOptions {
  readonly plugins?: ReadonlyArray<{ readonly type: "local"; readonly path: string }> | undefined;
  readonly settings?: string | object | undefined;
}

/** The settings as an object: an inline JSON string or a settings file; undefined when it can't be read. */
const settingsObject = (
  settings: string | object | undefined,
  readFile: (path: string) => string,
): Record<string, unknown> | undefined => {
  if (settings === undefined) return {};
  if (typeof settings === "object") return settings as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      settings.trimStart().startsWith("{") ? settings : readFile(settings),
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The open input with lastdrop's plugin loaded from `pluginPath` and the app's installed copy of it
 * (`lastdrop@lastdrop`) turned off in the query's flag settings (which outrank the user's), so each Agent type
 * shows once. Settings the query already has stay; a settings file that can't be read stays as it is.
 */
export const withLastdropPlugin = <I extends { readonly options: object }>(
  input: I,
  pluginPath: string,
  readFile: (path: string) => string = (path) => NodeFS.readFileSync(path, "utf8"),
): I => {
  const { plugins, settings } = input.options as PluginOptions;
  const current = settingsObject(settings, readFile);
  const enabled = (current?.enabledPlugins ?? {}) as Record<string, unknown>;
  return {
    ...input,
    options: {
      ...input.options,
      plugins: [
        ...(plugins ?? []).filter((p) => p.path !== pluginPath),
        { type: "local" as const, path: pluginPath },
      ],
      ...(current === undefined
        ? {}
        : { settings: { ...current, enabledPlugins: { ...enabled, [APP_PLUGIN_ID]: false } } }),
    },
  };
};
