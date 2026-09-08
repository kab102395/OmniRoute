import { createHash, randomBytes, randomUUID } from "crypto";
import { getDbInstance } from "./core";

export const GATEWAY_CLIENT_SCOPES = ["models:list", "completion:create"] as const;
export type GatewayClientScope = (typeof GATEWAY_CLIENT_SCOPES)[number];
const TOKEN_PREFIX = "ogc_live_";
const PREFIX_LENGTH = TOKEN_PREFIX.length + 6;
export function gatewayScopeForRequest(method: string, path: string): GatewayClientScope | null {
  const p = path.replace(/\/$/, "").toLowerCase();
  if (method.toUpperCase() === "GET" && p === "/api/v1/models") return "models:list";
  if (
    method.toUpperCase() === "POST" &&
    (p === "/api/v1/chat/completions" || p === "/api/v1/responses")
  )
    return "completion:create";
  return null;
}

export interface GatewayClientRecord {
  id: string;
  name: string;
  scopes: GatewayClientScope[];
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export type GatewayClientAuthResult =
  | { kind: "invalid" }
  | { kind: "insufficient"; record: GatewayClientRecord }
  | { kind: "ok"; record: GatewayClientRecord };

interface Row {
  id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
function rowRecord(row: Row): GatewayClientRecord {
  let scopes: GatewayClientScope[] = [];
  try {
    scopes = JSON.parse(row.scopes).filter((x: unknown): x is GatewayClientScope =>
      GATEWAY_CLIENT_SCOPES.includes(x as GatewayClientScope)
    );
  } catch {
    /* fail closed */
  }
  return {
    id: row.id,
    name: row.name,
    scopes,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createGatewayClient(input: { name: string; scopes?: GatewayClientScope[] }): {
  record: GatewayClientRecord;
  secret: string;
} {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Gateway client name is required");
  const scopes = [...new Set(input.scopes || [...GATEWAY_CLIENT_SCOPES])].filter(
    (x): x is GatewayClientScope => GATEWAY_CLIENT_SCOPES.includes(x)
  );
  if (!scopes.length) throw new Error("At least one gateway scope is required");
  const secret = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record = {
    id: `gwc_${randomUUID()}`,
    name,
    scopes,
    tokenPrefix: secret.slice(0, PREFIX_LENGTH),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  } satisfies GatewayClientRecord;
  getDbInstance()
    .prepare(
      `INSERT INTO gateway_client_credentials (id, token_hash, token_prefix, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      hash(secret),
      record.tokenPrefix,
      record.name,
      JSON.stringify(record.scopes),
      record.createdAt
    );
  return { record, secret };
}

export function authenticateGatewayClient(
  secret: string | null | undefined,
  required: GatewayClientScope
): GatewayClientAuthResult {
  if (!secret || typeof secret !== "string" || !secret.startsWith(TOKEN_PREFIX))
    return { kind: "invalid" };
  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM gateway_client_credentials WHERE token_hash = ?")
    .get(hash(secret)) as Row | undefined;
  if (!row || row.revoked_at) return { kind: "invalid" };
  const record = rowRecord(row);
  if (!record.scopes.includes(required)) return { kind: "insufficient", record };
  try {
    db.prepare("UPDATE gateway_client_credentials SET last_used_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      record.id
    );
  } catch {
    /* audit stamp is best effort */
  }
  return { kind: "ok", record };
}
export function verifyGatewayClient(
  secret: string | null | undefined,
  required: GatewayClientScope
): GatewayClientRecord | null {
  const result = authenticateGatewayClient(secret, required);
  return result.kind === "ok" ? result.record : null;
}

export function listGatewayClients(): GatewayClientRecord[] {
  return (
    getDbInstance()
      .prepare("SELECT * FROM gateway_client_credentials ORDER BY created_at DESC")
      .all() as Row[]
  ).map(rowRecord);
}
export function getGatewayClient(id: string): GatewayClientRecord | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM gateway_client_credentials WHERE id = ?")
    .get(id) as Row | undefined;
  return row ? rowRecord(row) : null;
}
export function revokeGatewayClient(id: string): boolean {
  return (
    (getDbInstance()
      .prepare(
        "UPDATE gateway_client_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND revoked_at IS NULL"
      )
      .run(new Date().toISOString(), id).changes || 0) > 0
  );
}
export function rotateGatewayClient(
  id: string
): { record: GatewayClientRecord; secret: string } | null {
  const current = getGatewayClient(id);
  if (!current || current.revokedAt) return null;
  revokeGatewayClient(id);
  return createGatewayClient({ name: current.name, scopes: current.scopes });
}
