/**
 * The fork's desktop startup, imported first by `main.ts` so it runs before any T3 module loads.
 *
 * It turns on the fork's identity (`identity.ts`). The fork uses T3's own home (`~/.t3`, or
 * `T3CODE_HOME`) exactly as T3 resolves it; lastdrop's own files live under `<home>/lastdrop/`
 * (`apps/server/src/extensions/dataDir.ts`).
 */
import * as Identity from "./identity.ts";

Identity.activate();
