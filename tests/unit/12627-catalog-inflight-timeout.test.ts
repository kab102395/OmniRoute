/**
 * #12627 — a hung coalesced catalog rebuild must not pin later GET /v1/models clients.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-12627-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");

function request() {
  return new Request("http://localhost/v1/models");
}

function freeOnlyRequest() {
  return new Request("http://localhost/v1/models?free_only=true");
}

function payload(body: string): catalogCache.CatalogPayload {
  return { body, headers: { "content-type": "application/json" }, status: 200, cacheTTL: 60_000 };
}

const neverResolves = () => new Promise(() => {});

test.beforeEach(() => {
  catalogCache.__resetCatalogBuilderRunsForTest();
  process.env.CATALOG_BUILD_TIMEOUT_MS = "40";
});

test.afterEach(() => {
  delete process.env.CATALOG_BUILD_TIMEOUT_MS;
});

test("#12627 cold hung rebuild times out instead of waiting forever", async () => {
  await assert.rejects(
    catalogCache.resolveCachedCatalogResponse(
      request(),
      { corsHeaders: {}, diagnosticHeaders: {} },
      neverResolves as (req: Request) => Promise<catalogCache.CatalogPayload>
    ),
    /catalog_build_timeout/
  );
});

test("#12627 timeout serves last-good 200 when a prior build succeeded", async () => {
  const first = await catalogCache.resolveCachedCatalogResponse(
    request(),
    { corsHeaders: {}, diagnosticHeaders: {} },
    async () => payload("good")
  );
  assert.equal(await first.text(), "good");
  catalogCache.__expireCatalogCacheForTest(60_000);

  const second = await catalogCache.resolveCachedCatalogResponse(
    request(),
    { corsHeaders: {}, diagnosticHeaders: {} },
    neverResolves as (req: Request) => Promise<catalogCache.CatalogPayload>
  );
  assert.equal(second.status, 200);
  assert.equal(await second.text(), "good");
  assert.equal(second.headers.get("x-omniroute-catalog"), "last-good");
});

test("#12627 free-only timeout does not serve stale route eligibility", async () => {
  const req = freeOnlyRequest();
  const first = await catalogCache.resolveCachedCatalogResponse(
    req,
    { corsHeaders: {}, diagnosticHeaders: {} },
    async () => payload("old-free-route"),
    { getStaleWhileRevalidateMs: () => 0 }
  );
  assert.equal(await first.text(), "old-free-route");
  catalogCache.__expireCatalogCacheForTest(60_000);

  await assert.rejects(
    catalogCache.resolveCachedCatalogResponse(
      req,
      { corsHeaders: {}, diagnosticHeaders: {} },
      neverResolves as (request: Request) => Promise<catalogCache.CatalogPayload>,
      { getStaleWhileRevalidateMs: () => 0 }
    ),
    /catalog_build_timeout/
  );
});
