// @effect-diagnostics nodeBuiltinImport:off - The runner script's file, and a per-server secret.
/**
 * How lastdrop's plugin finds the fork: each Claude query carries `LASTDROP_RUNNER` (this script),
 * `LASTDROP_RUNNER_URL` and `LASTDROP_RUNNER_TOKEN` (`<thread>.<HMAC>`, a per-server secret); the
 * plugin's `runner($)` prefers them over the standalone app. See docs/lastdrop/step8.md.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const RUNNER_PATH = "/api/lastdrop/runner";

const RUNNER_ENV = {
  runner: "LASTDROP_RUNNER",
  url: "LASTDROP_RUNNER_URL",
  token: "LASTDROP_RUNNER_TOKEN",
} as const;

const secret = NodeCrypto.randomBytes(32);

const mac = (threadId: string, key: Uint8Array): string =>
  NodeCrypto.createHmac("sha256", key).update(threadId).digest("base64url");

/** The token a thread's queries carry. */
export const threadToken = (threadId: string, key: Uint8Array = secret): string =>
  `${threadId}.${mac(threadId, key)}`;

/** The thread a token names, when its MAC holds. */
export const tokenThread = (token: string, key: Uint8Array = secret): string | undefined => {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const threadId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(threadId, key));
  return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected)
    ? threadId
    : undefined;
};

/**
 * The runner: posts its flag's request to the fork's route and prints the answer as it streams. `exec`
 * keeps one process, so the plugin ending it (an interrupted agent) closes the connection, and the
 * route stops the run. A curl failure (no server) prints nothing, which the plugin reports as such.
 */
export const RUNNER_SCRIPT = `#!/bin/sh
# lastdrop's runner inside T3 Code lastdrop (the T3 Code fork). lastdrop's Claude Code plugin runs it
# instead of the lastdrop app when LASTDROP_RUNNER names it; it answers through the fork's server.
# Written by the fork's server at each start; changes are overwritten.
: "\${LASTDROP_RUNNER_URL:?not inside a T3 Code lastdrop thread}"
: "\${LASTDROP_RUNNER_TOKEN:?not inside a T3 Code lastdrop thread}"
post() {
  exec /usr/bin/curl --silent --show-error --no-buffer --fail-with-body \\
    -H "authorization: Bearer $LASTDROP_RUNNER_TOKEN" "$@"
}
case "$1" in
  --agent-run|--agent-route|--agent-warm|--delegate-note)
    post -H 'content-type: application/json' --data-binary @- "$LASTDROP_RUNNER_URL/\${1#--}" ;;
  --agent-stop|--agent-open)
    post --data-urlencode "id=$2" "$LASTDROP_RUNNER_URL/\${1#--}" ;;
  --agent-catalog|--agent-selftest)
    post --data-binary '' "$LASTDROP_RUNNER_URL/\${1#--}" ;;
  --agents)
    shift
    set -- --data-urlencode "args=$*" "$LASTDROP_RUNNER_URL/agents"
    post "$@" ;;
  *)
    echo "lastdrop (T3 Code lastdrop): unknown command $1" >&2
    exit 2 ;;
esac
`;

/** Writes the runner script under lastdrop's folder (when it changed) and returns its path. */
export const installRunnerScript = (dataDir: string): string => {
  const file = NodePath.join(dataDir, "bin", "lastdrop");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  let current: string | undefined;
  try {
    current = NodeFS.readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== RUNNER_SCRIPT) {
    const temporary = `${file}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temporary, RUNNER_SCRIPT, { mode: 0o755 });
    NodeFS.renameSync(temporary, file);
  }
  NodeFS.chmodSync(file, 0o755);
  return file;
};

interface Binding {
  readonly script: string;
  readonly url: string;
}

let bound: Binding | undefined;

/** Called once the routes listen (`routes.ts`). */
export const bindRunner = (binding: Binding): void => {
  bound = binding;
};

export const unbindRunner = (): void => {
  bound = undefined;
};

/** The variables a thread's Claude query gains; undefined until the routes are bound. */
export const runnerEnvironment = (
  threadId: string,
  key: Uint8Array = secret,
): Record<string, string> | undefined =>
  bound === undefined
    ? undefined
    : {
        [RUNNER_ENV.runner]: bound.script,
        [RUNNER_ENV.url]: bound.url,
        [RUNNER_ENV.token]: threadToken(threadId, key),
      };
