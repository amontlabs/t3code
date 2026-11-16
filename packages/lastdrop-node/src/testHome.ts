/**
 * Test support: a temporary home with a fake `security` tool, so tests never read or write the real
 * `~/.claude`, `~/.t3` or the keychain.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { lastdropPaths, type LastdropPaths } from "./paths.ts";

export interface TestHome {
  readonly root: string;
  readonly paths: LastdropPaths;
  /** Stores a keychain item the fake `security` returns for `service`. */
  setKeychain(service: string, value: string): void;
  hasKeychain(service: string): boolean;
  /** Stores an item for `service` and `account`, which wins over the service-only item for that account. */
  setKeychainItem(service: string, account: string, value: string): void;
  /** While locked, the fake `security` fails like a locked keychain (51), for every item. */
  lockKeychain(locked: boolean): void;
  write(path: string, value: unknown): void;
  read(path: string): Record<string, unknown>;
  remove(): void;
}

/** `prefix` may hold a space, for paths that must survive one. */
export function makeTestHome(prefix = "lastdrop-node-"): TestHome {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  const home = `${root}/home`;
  const items = `${root}/keychain`;
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(items, { recursive: true });
  const security = `${root}/security`;
  // find-generic-password -s <service> [-a <account>] -w prints the item, delete-generic-password removes it;
  // either fails like the real tool (44) when there's none.
  NodeFS.writeFileSync(
    security,
    `#!/bin/sh
service=""
account=""
command="$1"
[ -f "${root}/locked" ] && exit 51
while [ $# -gt 0 ]; do
  case "$1" in
    -s) service="$2"; shift 2;;
    -a) account="$2"; shift 2;;
    *) shift;;
  esac
done
file="${items}/$(printf '%s' "$service" | od -An -tx1 | tr -d ' \\n')"
if [ -n "$account" ]; then
  own="${items}/$(printf '%s/%s' "$service" "$account" | od -An -tx1 | tr -d ' \\n')"
  [ -f "$own" ] && file="$own"
fi
[ -f "$file" ] || exit 44
if [ "$command" = "delete-generic-password" ]; then rm "$file"; exit 0; fi
cat "$file"
`,
    { mode: 0o755 },
  );
  const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
  return {
    root,
    paths: lastdropPaths({ home, dataDir: `${home}/.t3/lastdrop`, security }),
    setKeychain: (service, value) => NodeFS.writeFileSync(`${items}/${hex(service)}`, value),
    hasKeychain: (service) => NodeFS.existsSync(`${items}/${hex(service)}`),
    lockKeychain: (locked) =>
      locked
        ? NodeFS.writeFileSync(`${root}/locked`, "")
        : NodeFS.rmSync(`${root}/locked`, { force: true }),
    setKeychainItem: (service, account, value) =>
      NodeFS.writeFileSync(`${items}/${hex(`${service}/${account}`)}`, value),
    write: (path, value) => {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    read: (path) => {
      try {
        return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    remove: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}
