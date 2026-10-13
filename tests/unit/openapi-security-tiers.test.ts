import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const OPENAPI_PATH = path.join(ROOT, "docs", "openapi.yaml");

const {
  LOCAL_ONLY_API_PREFIXES,
  LOCAL_ONLY_API_PATTERNS,
  ALWAYS_PROTECTED_API_PATHS,
  ALWAYS_PROTECTED_API_PATTERNS,
} = await import("../../src/server/authz/routeGuard.ts");

const raw: any = yaml.load(fs.readFileSync(OPENAPI_PATH, "utf-8"));
const paths: Record<string, any> = raw.paths || {};

test("every x-loopback-only path matches a LOCAL_ONLY prefix or pattern in routeGuard.ts", () => {
  for (const [pathStr, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, spec] of Object.entries(methods as Record<string, any>)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (spec?.["x-loopback-only"] !== true) continue;
      const matchesPrefix = (LOCAL_ONLY_API_PREFIXES as ReadonlyArray<string>).some(
        (prefix: string) => {
          const norm = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
          return pathStr === norm || pathStr.startsWith(norm + "/");
        }
      );
      // Param-shaped routes (e.g. /api/providers/{id}/login) are classified by
      // LOCAL_ONLY_API_PATTERNS regexes rather than a static prefix — the OpenAPI
      // {param} placeholder satisfies the same [^/]+ segment the runtime matches.
      const matchesPattern = (LOCAL_ONLY_API_PATTERNS as ReadonlyArray<RegExp>).some((re) =>
        re.test(pathStr)
      );
      assert.ok(
        matchesPrefix || matchesPattern,
        `YAML path "${pathStr}" ${method.toUpperCase()} has x-loopback-only but is NOT in LOCAL_ONLY_API_PREFIXES ` +
          `or LOCAL_ONLY_API_PATTERNS. Add it to routeGuard.ts or remove x-loopback-only.`
      );
    }
  }
});

test("GET /api/openapi/spec documents its conditional management auth contract", () => {
  const operation = paths["/api/openapi/spec"]?.get;

  assert.deepEqual(operation?.security, [{ ManagementSessionAuth: [] }]);
  assert.match(operation?.description ?? "", /When `requireLogin` is enabled/);
  assert.equal(
    operation?.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(
    operation?.responses?.["403"]?.$ref,
    "#/components/responses/ManagementInvalidToken"
  );
});

test("provider connection inventory documents its management auth and Praxis read contract", () => {
  const operation = paths["/api/providers"]?.get;
  assert.deepEqual(operation?.security, [{ ManagementSessionAuth: [] }, { BearerAuth: [] }]);
  assert.match(operation?.description ?? "", /when `requireLogin` is enabled/i);
  assert.match(operation?.description ?? "", /tokens are never returned/i);
  assert.deepEqual(
    operation?.parameters?.map((parameter: { name?: string }) => parameter.name),
    ["provider", "limit", "offset"]
  );
  assert.equal(
    operation?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderConnectionsResponse"
  );
  assert.equal(
    operation?.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(
    operation?.responses?.["403"]?.$ref,
    "#/components/responses/ManagementInvalidToken"
  );

  const response = raw.components?.schemas?.ProviderConnectionsResponse;
  const connection = raw.components?.schemas?.ProviderConnection;
  assert.deepEqual(response?.required, ["connections", "total"]);
  assert.equal(response?.properties?.total?.type, "integer");
  for (const field of [
    "id",
    "provider",
    "authType",
    "isActive",
    "testStatus",
    "rateLimitedUntil",
  ]) {
    assert.ok(connection?.properties?.[field], `provider connection must document ${field}`);
  }
  assert.match(connection?.properties?.apiKey?.description ?? "", /masked by default/i);
});

test("call-log detail contract exposes persisted execution attempt accounting", () => {
  const operation = paths["/api/usage/call-logs/{id}"]?.get;
  const completionOperation = paths["/api/v1/chat/completions"]?.post;
  assert.deepEqual(operation?.security, [{ ManagementSessionAuth: [] }, { BearerAuth: [] }]);
  assert.match(operation?.description ?? "", /X-OmniRoute-Request-Id/i);
  assert.equal(
    operation?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CallLogDetail"
  );
  assert.equal(
    operation?.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(
    operation?.responses?.["403"]?.$ref,
    "#/components/responses/ManagementInvalidToken"
  );
  assert.ok(operation?.responses?.["404"]);

  const detail = raw.components?.schemas?.CallLogDetail;
  const attempts = raw.components?.schemas?.CallLogExecutionAttempt;
  const accounting = raw.components?.schemas?.CallLogAccounting;
  const zeroCostParameter = completionOperation?.parameters?.find(
    (parameter) => parameter.name === "X-OmniRoute-Require-Zero-Cost"
  );
  assert.equal(zeroCostParameter?.in, "header");
  assert.match(zeroCostParameter?.description ?? "", /documented hard stop/i);
  assert.match(zeroCostParameter?.description ?? "", /quota/i);
  assert.equal(
    detail?.properties?.pipelinePayloads?.properties?.executionAttempts?.items?.$ref,
    "#/components/schemas/CallLogExecutionAttempt"
  );
  assert.equal(detail?.properties?.pipelinePayloads?.properties?.executionAttempts?.maxItems, 64);
  assert.deepEqual(attempts?.properties?.costAttribution?.enum, [
    "unknown",
    "provider_reported",
    "estimated",
  ]);
  assert.deepEqual(accounting?.properties?.kind?.enum, [
    "provider_reported_billed_cost",
    "estimated_cost",
    "usage_only",
    "unknown",
    "zero_cost",
    "pending",
  ]);
  assert.equal(accounting?.properties?.amountUsdExact?.type, "string");
  assert.equal(accounting?.properties?.amountUsd?.nullable, true);
  assert.equal(accounting?.properties?.downstreamProvider?.type, "string");
  assert.equal(accounting?.properties?.providerReceipts?.maxItems, 8);
  const attemptHeader =
    completionOperation?.responses?.["200"]?.headers?.["X-OmniRoute-Execution-Attempts"];
  assert.equal(attemptHeader?.schema?.maxLength, 6000);
  assert.match(attemptHeader?.description ?? "", /URI-component-encoded JSON array/i);
  assert.equal(
    accounting?.properties?.providerReceipts?.items?.properties?.source?.enum?.[0],
    "openrouter.generation_api"
  );
  assert.match(
    completionOperation?.responses?.["200"]?.headers?.["X-OmniRoute-Request-Id"]?.description ?? "",
    /same ID is persisted with the completed execution receipt/i
  );
  assert.match(
    detail?.properties?.id?.description ?? "",
    /completed non-streaming and streaming responses/i
  );
});

test("provider-limits documents cached quota provenance and management auth", () => {
  const getOperation = paths["/api/usage/provider-limits"]?.get;
  const postOperation = paths["/api/usage/provider-limits"]?.post;

  for (const operation of [getOperation, postOperation]) {
    assert.deepEqual(operation?.security, [{ ManagementSessionAuth: [] }, { BearerAuth: [] }]);
    assert.match(operation?.description ?? "", /when `requireLogin` is enabled/i);
    assert.equal(
      operation?.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(
      operation?.responses?.["403"]?.$ref,
      "#/components/responses/ManagementInvalidToken"
    );
    assert.equal(
      operation?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/ProviderLimitsResponse"
    );
  }

  assert.match(postOperation?.description ?? "", /does not execute model inference/i);
  const entry = raw.components?.schemas?.ProviderLimitsCacheEntry;
  assert.deepEqual(entry?.required, ["quotas", "plan", "message", "fetchedAt"]);
  assert.equal(entry?.properties?.fetchedAt?.format, "date-time");
  assert.equal(entry?.properties?.source?.nullable, true);
  assert.deepEqual(entry?.properties?.freshness?.properties?.status?.enum, [
    "fresh",
    "stale",
    "unknown",
  ]);
  assert.equal(entry?.properties?.freshness?.properties?.ageMs?.nullable, true);
  assert.equal(entry?.properties?.billing?.type, "object");
});

test("provider health matrix documents account and model routing health", () => {
  const operation = paths["/api/providers/health-matrix"]?.get;
  assert.deepEqual(operation?.security, [{ ManagementSessionAuth: [] }, { BearerAuth: [] }]);
  assert.match(operation?.description ?? "", /not a guarantee that a future request will succeed/i);
  assert.match(operation?.description ?? "", /without positive health evidence are `unknown`/i);
  assert.deepEqual(
    operation?.parameters?.find((parameter: { name?: string }) => parameter.name === "range")
      ?.schema?.enum,
    ["1h", "24h", "7d", "30d"]
  );
  assert.deepEqual(
    operation?.parameters?.find(
      (parameter: { name?: string }) => parameter.name === "includeHealthy"
    )?.schema?.enum,
    ["true", "false", "1", "0"]
  );
  assert.equal(
    operation?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderHealthMatrixResponse"
  );
  assert.ok(operation?.responses?.["400"]);

  const providerSchema = raw.components?.schemas?.ProviderHealthMatrixProvider;
  const accountSchema = raw.components?.schemas?.ProviderHealthMatrixAccount;
  assert.equal(providerSchema?.properties?.circuitBreaker?.nullable, true);
  assert.deepEqual(providerSchema?.properties?.state?.enum, [
    "healthy",
    "degraded",
    "down",
    "unknown",
  ]);
  assert.equal(providerSchema?.properties?.score?.nullable, true);
  assert.ok(
    raw.components?.schemas?.ProviderHealthMatrixResponse?.properties?.summary?.properties
      ?.unknownCount
  );
  assert.equal(providerSchema?.properties?.modelLockoutCount?.type, "integer");
  assert.deepEqual(accountSchema?.properties?.state?.enum, [
    "healthy",
    "degraded",
    "down",
    "unknown",
  ]);
  assert.equal(accountSchema?.properties?.rateLimitedUntil?.format, "date-time");
  assert.deepEqual(accountSchema?.properties?.models?.items?.properties?.status?.enum, [
    "healthy",
    "degraded",
    "error",
    "locked",
    "idle",
  ]);
});

test("model catalog schema documents selectable model constraints and capabilities", () => {
  const operation = paths["/api/v1/models"]?.get;
  const modelSchema = raw.components?.schemas?.Model;
  assert.equal(
    operation?.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.data?.items
      ?.$ref,
    "#/components/schemas/Model"
  );
  for (const field of [
    "free",
    "pricing",
    "pricing_provenance",
    "capabilities",
    "capability_status",
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
    "input_modalities",
    "output_modalities",
    "supported_parameters",
    "route_selection",
    "route_availability",
    "provider_routes",
    "provider_routes_provenance",
  ]) {
    assert.ok(modelSchema?.properties?.[field], `Model schema must document ${field}`);
  }
  assert.equal(modelSchema?.properties?.free?.type, "boolean");
  assert.equal(modelSchema?.properties?.context_length?.minimum, 1);
  assert.deepEqual(modelSchema?.properties?.capabilities?.additionalProperties?.oneOf, [
    { type: "boolean" },
    { type: "array", items: { type: "string" } },
  ]);
});

test("POST /api/openapi/try documents its bounded management proxy contract", () => {
  const operation = paths["/api/openapi/try"]?.post;

  assert.ok(operation, "POST /api/openapi/try must be present in docs/openapi.yaml");
  assert.deepEqual(operation.security, [{ BearerAuth: [] }, { ManagementSessionAuth: [] }]);
  assert.match(operation.description ?? "", /same-origin/);
  assert.match(operation.description ?? "", /When `requireLogin` is disabled/);

  const requestBody = operation.requestBody;
  const requestSchema = requestBody?.content?.["application/json"]?.schema;
  assert.equal(requestBody?.required, true);
  assert.equal(requestSchema?.type, "object");
  assert.deepEqual(requestSchema?.required, ["path"]);
  assert.deepEqual(requestSchema?.properties?.method?.enum, [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ]);
  assert.equal(requestSchema?.properties?.method?.default, "GET");
  assert.equal(requestSchema?.properties?.path?.minLength, 1);
  assert.equal(
    requestSchema?.properties?.path?.pattern,
    "^/(?:api/|v1/|v1beta/|a2a|\\.well-known/agent\\.json)"
  );
  assert.equal(requestSchema?.properties?.headers?.type, "object");
  assert.deepEqual(requestSchema?.properties?.headers?.additionalProperties, {
    type: "string",
  });
  assert.deepEqual(requestSchema?.properties?.headers?.default, {});
  assert.ok("body" in requestSchema.properties);

  const successSchema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.equal(successSchema?.type, "object");
  assert.equal(successSchema?.additionalProperties, false);
  assert.deepEqual(successSchema?.required, [
    "status",
    "statusText",
    "headers",
    "body",
    "latencyMs",
    "contentType",
  ]);
  assert.equal(successSchema?.properties?.status?.type, "integer");
  assert.equal(successSchema?.properties?.status?.minimum, 0);
  assert.equal(successSchema?.properties?.statusText?.type, "string");
  assert.equal(successSchema?.properties?.headers?.type, "object");
  assert.deepEqual(successSchema?.properties?.headers?.additionalProperties, {
    type: "string",
  });
  assert.match(successSchema?.properties?.body?.description ?? "", /10,000 characters/);
  assert.equal(successSchema?.properties?.latencyMs?.type, "integer");
  assert.equal(successSchema?.properties?.latencyMs?.minimum, 0);
  assert.equal(successSchema?.properties?.contentType?.type, "string");

  const badRequestSchema = operation.responses?.["400"]?.content?.["application/json"]?.schema;
  assert.equal(badRequestSchema?.oneOf?.length, 2);
  assert.equal(badRequestSchema?.oneOf?.[0]?.$ref, "#/components/schemas/ValidationErrorResponse");
  assert.equal(badRequestSchema?.oneOf?.[1]?.properties?.error?.type, "string");
  assert.equal(
    operation.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(operation.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
  assert.equal(operation.responses?.["503"]?.$ref, "#/components/responses/InternalError");
});

test("every x-always-protected path matches ALWAYS_PROTECTED_API_PATHS in routeGuard.ts", () => {
  for (const [pathStr, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, spec] of Object.entries(methods as Record<string, any>)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (spec?.["x-always-protected"] !== true) continue;
      // Routes with a dynamic segment cannot be expressed in the plain
      // exact/prefix list, so routeGuard also carries ALWAYS_PROTECTED_API_PATTERNS
      // (GHSA-5926-2w35-7h4q). Substitute a concrete value for the OpenAPI
      // `{param}` placeholders before testing those.
      const concretePath = pathStr.replace(/\{[^}]+\}/g, "sample-id");
      const matchesPath =
        (ALWAYS_PROTECTED_API_PATHS as ReadonlyArray<string>).some(
          (p: string) => pathStr === p || pathStr.startsWith(`${p}/`)
        ) ||
        (ALWAYS_PROTECTED_API_PATTERNS as ReadonlyArray<RegExp>).some((re) =>
          re.test(concretePath)
        );
      assert.ok(
        matchesPath,
        `YAML path "${pathStr}" ${method.toUpperCase()} has x-always-protected but is NOT in ALWAYS_PROTECTED_API_PATHS ` +
          `nor matched by ALWAYS_PROTECTED_API_PATTERNS. ` +
          `Entries: ${(ALWAYS_PROTECTED_API_PATHS as ReadonlyArray<string>).join(", ")}`
      );
    }
  }
});

test("spec route error response uses sanitizeErrorMessage (no raw error.message)", () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, "src/app/api/openapi/spec/route.ts"), "utf-8");
  assert.ok(
    routeSrc.includes("sanitizeErrorMessage"),
    "spec route must use sanitizeErrorMessage() to prevent stack trace leakage in error responses"
  );
  assert.ok(
    !routeSrc.match(/\berror\.message\b/),
    "spec route must not expose raw error.message in HTTP responses"
  );
});

test("spec route catalog exposes vendor extension fields when endpoints are documented", () => {
  const raw2: any = yaml.load(fs.readFileSync(OPENAPI_PATH, "utf-8"));
  const endpoints: any[] = [];
  for (const [pathStr, methods] of Object.entries(raw2.paths as Record<string, any>)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, spec] of Object.entries(methods as Record<string, any>)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method) || !spec) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path: pathStr,
        loopbackOnly: spec["x-loopback-only"] === true,
        alwaysProtected: spec["x-always-protected"] === true,
        internal: spec["x-internal"] === true,
      });
    }
  }

  // /api/mcp/sse and /api/shutdown are the canonical examples of loopback-only and
  // always-protected tiers. The OpenAPI audit (#2701) intends to back-fill them
  // with vendor extension annotations; until that backlog completes, only enforce
  // the security tier WHEN the endpoint is documented. Adding the endpoint
  // without the correct tier is still a regression and continues to fail.
  const mcpSse = endpoints.find((e) => e.path === "/api/mcp/sse" && e.method === "GET");
  if (mcpSse) {
    assert.equal(mcpSse.loopbackOnly, true, "GET /api/mcp/sse must have loopbackOnly: true");
  }

  const shutdown = endpoints.find((e) => e.path === "/api/shutdown" && e.method === "POST");
  if (shutdown) {
    assert.equal(
      shutdown.alwaysProtected,
      true,
      "POST /api/shutdown must have alwaysProtected: true"
    );
  }
});
