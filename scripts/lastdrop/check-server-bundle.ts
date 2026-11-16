// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small sync CLI over one directory.
/**
 * The server bundle must keep a single `server-*.mjs` chunk (`scripts/lib/server-compile-cache.ts` rejects two).
 * A dynamic import of a module that `server.ts` also imports statically (or a lazy wrapper around it) can split
 * a second one off; `apps/server/src/extensions/index.ts` explains the case that did.
 *
 *   node scripts/lastdrop/check-server-bundle.ts [apps/server/dist]
 */
import * as NodeFS from "node:fs";

const dist = process.argv[2] ?? "apps/server/dist";
const servers = NodeFS.readdirSync(dist).filter((file) => /^server-.*\.mjs$/.test(file));
if (servers.length !== 1) {
  console.error(
    `Expected one server-*.mjs in ${dist}, found ${servers.length}: ${servers.join(", ")}`,
  );
  process.exit(1);
}
console.log(`ok: ${servers[0]}`);
