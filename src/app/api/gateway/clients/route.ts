import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createGatewayClient,
  GATEWAY_CLIENT_SCOPES,
  listGatewayClients,
} from "@/lib/db/gatewayClientCredentials";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(GATEWAY_CLIENT_SCOPES)).min(1).optional(),
});
export async function GET(request: Request) {
  const error = await requireManagementAuth(request);
  if (error) return error;
  return NextResponse.json({ clients: listGatewayClients() });
}
export async function POST(request: Request) {
  const error = await requireManagementAuth(request);
  if (error) return error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid gateway client request" }, { status: 400 });
  const { record, secret } = createGatewayClient(parsed.data);
  return NextResponse.json({ success: true, token: secret, ...record });
}
