import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { reconcileRenumberedMigrations } from "../../src/lib/db/migrationRunner/schemaState.ts";

const currentMigrationFiles = [
  {
    version: "174",
    name: "gateway_client_credentials",
    path: "174_gateway_client_credentials.sql",
  },
  {
    version: "175",
    name: "call_logs_provider_key_slot",
    path: "175_call_logs_provider_key_slot.sql",
  },
  {
    version: "176",
    name: "chat_completion_provenance",
    path: "176_chat_completion_provenance.sql",
  },
];

function createLedger(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _omniroute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

test("canonical 174 gateway and 175 key-slot ledger is left unchanged", () => {
  const db = createLedger();
  try {
    db.exec(`
      INSERT INTO _omniroute_migrations (version, name) VALUES
        ('174', 'gateway_client_credentials'),
        ('175', 'call_logs_provider_key_slot');
    `);

    assert.equal(reconcileRenumberedMigrations(db, currentMigrationFiles), false);
    assert.deepEqual(
      db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
      [
        { version: "174", name: "gateway_client_credentials" },
        { version: "175", name: "call_logs_provider_key_slot" },
      ]
    );
  } finally {
    db.close();
  }
});

test("legacy provenance marker at 174 is safely rehomed to 176", () => {
  const db = createLedger();
  try {
    db.exec(`
      INSERT INTO _omniroute_migrations (version, name)
      VALUES ('174', 'chat_completion_provenance');
    `);

    assert.equal(reconcileRenumberedMigrations(db, currentMigrationFiles), true);
    assert.deepEqual(
      db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
      [{ version: "176", name: "chat_completion_provenance" }]
    );
    assert.equal(reconcileRenumberedMigrations(db, currentMigrationFiles), false);
  } finally {
    db.close();
  }
});
