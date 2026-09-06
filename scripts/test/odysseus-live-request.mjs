const endpoint = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128";
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required; no request was sent.");
  process.exit(2);
}

const model = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
const response = await fetch(`${endpoint}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-odysseus-task-id": `live-${Date.now()}`,
    "x-odysseus-role": "scout",
    "x-odysseus-privacy-class": "public",
    "x-odysseus-free-only": "true",
    "x-odysseus-allowed-routes": model,
    "x-odysseus-policy-version": "2026-09-05",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly: ODYSSEUS_LIVE_OK" }],
    max_tokens: 16,
    stream: false,
  }),
});
const body = await response.text();
console.log(`status=${response.status}`);
console.log(`policy=${response.headers.get("x-odysseus-policy-result") || "unavailable"}`);
console.log(`provider=${response.headers.get("x-odysseus-provider") || "unavailable"}`);
console.log(`actual_model=${response.headers.get("x-odysseus-actual-model") || "unavailable"}`);
console.log(`telemetry=${response.headers.get("x-odysseus-telemetry") || "unavailable"}`);
console.log(`body=${body.replaceAll(apiKey, "[REDACTED]")}`);
if (!response.ok) process.exit(1);
