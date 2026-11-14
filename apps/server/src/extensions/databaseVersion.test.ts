// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway SQLite files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BUILD_MIGRATION_HEAD } from "../persistence/databaseMigrationHead.ts";
import { migrationManifest } from "../persistence/Migrations.ts";
import { NewerDatabaseError, newerMigrations, refuseNewerDatabase } from "./databaseVersion.ts";

function databaseWith(ids: ReadonlyArray<readonly [number, string]>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-db-"));
  const dbPath = NodePath.join(dir, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)",
  );
  const insert = db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)");
  for (const [id, name] of ids) insert.run(id, name);
  db.close();
  return dbPath;
}

it.effect("passes a missing database and one this build knows", () =>
  Effect.gen(function* () {
    yield* refuseNewerDatabase("/missing/statev2.sqlite");
    yield* refuseNewerDatabase(databaseWith(migrationManifest));
  }),
);

it.effect("refuses a database a newer build migrated, without writing to it", () =>
  Effect.gen(function* () {
    const dbPath = databaseWith([...migrationManifest, [BUILD_MIGRATION_HEAD + 1, "Future"]]);
    const before = NodeFS.readFileSync(dbPath);
    assert.deepEqual(newerMigrations(dbPath), [`${BUILD_MIGRATION_HEAD + 1}_Future`]);
    const error = yield* Effect.flip(refuseNewerDatabase(dbPath));
    assert.instanceOf(error, NewerDatabaseError);
    assert.include(error.message, `${BUILD_MIGRATION_HEAD + 1}_Future`);
    assert.deepEqual(NodeFS.readFileSync(dbPath), before);
    assert.isFalse(NodeFS.existsSync(`${dbPath}-wal`));
  }),
);
