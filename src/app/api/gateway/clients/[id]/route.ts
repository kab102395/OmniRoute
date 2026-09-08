import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getGatewayClient,
  revokeGatewayClient,
  rotateGatewayClient,
} from "@/lib/db/gatewayClientCredentials";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const error = await requireManagementAuth(request);
  if (error) return error;
  const { id } = await params;
  const record = getGatewayClient(id);
  return record
    ? NextResponse.json(record)
    : NextResponse.json({ error: "Gateway client not found" }, { status: 404 });
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const error = await requireManagementAuth(request);
  if (error) return error;
  const { id } = await params;
  return revokeGatewayClient(id)
    ? NextResponse.json({ success: true, id })
    : NextResponse.json({ error: "Gateway client not found or already revoked" }, { status: 404 });
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const error = await requireManagementAuth(request);
  if (error) return error;
  const { id } = await params;
  const rotated = rotateGatewayClient(id);
  return rotated
    ? NextResponse.json({ success: true, token: rotated.secret, ...rotated.record })
    : NextResponse.json({ error: "Gateway client not found or revoked" }, { status: 404 });
}
