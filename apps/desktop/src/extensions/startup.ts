/**
 * The fork's desktop startup, imported first by `main.ts` so it runs before any T3 module loads.
 *
 * It turns on the fork's identity (`identity.ts`) and points `T3CODE_HOME` at the fork's own
 * folder unless the user set one; T3 already resolves its home, state, CLI shim and backend
 * from that variable. On a packaged app's first launch it copies `~/.t3` into that folder once.
 */
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Runs before the Effect runtime exists.
import * as NodePath from "node:path";
import * as Electron from "electron";

import * as Identity from "./identity.ts";
import { importOfficialHome } from "./importOfficialHome.ts";

function prepareHome(): void {
  if (process.env.T3CODE_HOME?.trim()) return;
  const homeDirectory = NodeOS.homedir();
  const packaged = Electron.app.isPackaged;
  const targetHome = NodePath.join(
    homeDirectory,
    packaged ? Identity.HOME_DIR_NAME : Identity.DEV_HOME_DIR_NAME,
  );
  process.env.T3CODE_HOME = targetHome;
  if (!packaged) return;
  const sourceHome = NodePath.join(homeDirectory, Identity.OFFICIAL_HOME_DIR_NAME);
  try {
    importOfficialHome({ sourceHome, targetHome });
  } catch (error) {
    Electron.dialog.showErrorBox(
      `${Identity.APP_BASE_NAME} could not copy your T3 Code data`,
      `${String(error)}\n\nIt starts without your projects and threads. To try again, quit, ` +
        `delete ${targetHome}, and open the app. ${sourceHome} was not changed.`,
    );
  }
}

Identity.activate();
if (!process.argv.includes("--version")) prepareHome();
