/**
 * The official T3 Code can update ahead of the fork and migrate the shared database. T3's own
 * migrator then runs nothing and an older server would read and write a schema it does not know.
 * T3 refuses that only for its background service (`cloud/servicePreflight.ts`), so the fork
 * checks before anything opens the database (`server.ts`, right after the ownership lock).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";

export class NewerDatabaseError extends Schema.TaggedError<NewerDatabaseError>()(
  "NewerDatabaseError",
  { dbPath: Schema.String, migrations: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.dbPath} was migrated by a newer T3 Code (migrations this build does not know: ${this.migrations.join(", ")}). T3 Code lastdrop stopped before opening it, so nothing was changed. Update T3 Code lastdrop (it follows T3's stable releases), or use the official T3 Code until then.`;
  }
}

/** Migrations recorded in `dbPath` that this build does not have; empty when none or unreadable. */
export function newerMigrations(dbPath: string): ReadonlyArray<string> {
  const recorded = recordedMigrations(dbPath);
  if (recorded === null) return [];
  return recorded
    .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
    .map(({ id, name }) => `${id}_${name}`);
}

/** Fails when a newer build migrated the database. Reads it read-only; a missing one passes. */
export const refuseNewerDatabase = Effect.fn("lastdrop.refuseNewerDatabase")(function* (
  dbPath: string,
) {
  const migrations = newerMigrations(dbPath);
  if (migrations.length > 0) return yield* new NewerDatabaseError({ dbPath, migrations });
});
