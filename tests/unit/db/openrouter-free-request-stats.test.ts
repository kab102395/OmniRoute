import assert from "node:assert/strict";
import test from "node:test";

const testDataDir = `/tmp/omniroute-openrouter-free-stats-${process.pid}`;
process.env.DATA_DIR = testDataDir;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const { getOpenrouterFreeRequestsToday } = await import("../../../src/lib/db/callLogStats.ts");

test.after(() => {
  core.resetDbInstance();
});

test("counts only today's persisted OpenRouter free-model requests for the connection", () => {
  const db = core.getDbInstance();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const insert = db.prepare(
    `INSERT INTO call_logs
      (id, timestamp, provider, connection_id, model, requested_model, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  insert.run(
    "free-1",
    `${today}T10:00:00.000Z`,
    "openrouter",
    "connection-a",
    "model-a:free",
    null,
    200
  );
  insert.run(
    "free-2",
    `${today}T10:01:00.000Z`,
    "openrouter",
    "connection-a",
    "model-b",
    "model-b:free",
    429
  );
  insert.run(
    "paid-1",
    `${today}T10:02:00.000Z`,
    "openrouter",
    "connection-a",
    "model-paid",
    null,
    200
  );
  insert.run(
    "other-1",
    `${today}T10:03:00.000Z`,
    "openrouter",
    "connection-b",
    "model-c:free",
    null,
    200
  );
  insert.run(
    "old-1",
    `${yesterday}T10:04:00.000Z`,
    "openrouter",
    "connection-a",
    "model-d:free",
    null,
    200
  );

  assert.equal(getOpenrouterFreeRequestsToday("connection-a"), 2);
  assert.equal(getOpenrouterFreeRequestsToday("connection-b"), 1);
  assert.equal(getOpenrouterFreeRequestsToday("missing"), 0);
});
