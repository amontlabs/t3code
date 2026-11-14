/**
 * Where lastdrop keeps its own files: `<T3 home>/lastdrop/` (`~/.t3/lastdrop/` by default), next
 * to T3's folders and never inside them. Dev runs, whose T3 state is `<home>/dev/`, use
 * `<home>/dev/lastdrop/` so they never share files with the installed app.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - A pure path rule shared with tests.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { ServerConfig } from "../config.ts";

const LASTDROP_DIR_NAME = "lastdrop";

/** lastdrop's folder for a T3 home (`baseDir`) and its state folder (`stateDir`). */
export function lastdropDataDir(input: {
  readonly baseDir: string;
  readonly stateDir: string;
}): string {
  const productionState = NodePath.join(input.baseDir, "userdata");
  return NodePath.resolve(input.stateDir) === NodePath.resolve(productionState)
    ? NodePath.join(input.baseDir, LASTDROP_DIR_NAME)
    : NodePath.join(input.stateDir, LASTDROP_DIR_NAME);
}

/** lastdrop's folder for the running server's T3 home. Does not create it. */
export const resolveLastdropDataDir = Effect.gen(function* () {
  return lastdropDataDir(yield* ServerConfig);
});
