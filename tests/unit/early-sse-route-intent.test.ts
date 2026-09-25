import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { resolveStreamFlag } from "../../open-sse/utils/aiSdkCompat.ts";

const ROUTES = [
  {
    name: "responses",
    sourceFormat: "openai-responses",
    bodyExpression: "resolvedBody?.stream",
    source: fs.readFileSync(path.join("src", "app", "api", "v1", "responses", "route.ts"), "utf8"),
  },
  {
    name: "messages",
    sourceFormat: "claude",
    bodyExpression: "body?.stream",
    source: fs.readFileSync(path.join("src", "app", "api", "v1", "messages", "route.ts"), "utf8"),
  },
] as const;

const CHAT_COMPLETIONS_SOURCE = fs.readFileSync(
  path.join("src", "app", "api", "v1", "chat", "completions", "route.ts"),
  "utf8"
);

for (const route of ROUTES) {
  test(`${route.name} early-heartbeat gate uses the real stream resolver`, () => {
    const escapedBodyExpression = route.bodyExpression.replace(/[.?\\]/g, "\\$&");
    assert.match(
      route.source,
      new RegExp(
        `resolveStreamFlag\\(\\s*${escapedBodyExpression},\\s*accept,\\s*"${route.sourceFormat}"\\s*\\)`
      )
    );
    assert.match(route.source, /if \(wantsStreaming\) \{[\s\S]*withEarlyStreamKeepalive\(/);
    assert.doesNotMatch(route.source, /accept\.includes\(["']text\/event-stream["']\)/);
  });

  test(`${route.name} stream intent covers body and Accept without overriding stream:false`, () => {
    assert.equal(resolveStreamFlag(true, "application/json", route.sourceFormat), true);
    assert.equal(resolveStreamFlag(false, "text/event-stream", route.sourceFormat), false);
    assert.equal(resolveStreamFlag(undefined, "text/event-stream", route.sourceFormat), true);
    assert.equal(resolveStreamFlag(undefined, "application/json", route.sourceFormat), false);
  });
}

test("chat-completions slow keepalive carries the pinned route identity", () => {
  assert.match(CHAT_COMPLETIONS_SOURCE, /deterministicProviderRouteHeaders\(/);
  assert.match(
    CHAT_COMPLETIONS_SOURCE,
    /extraHeaders:\s*\{[\s\S]*deterministicProviderRouteHeaders\(getDeterministicProviderRoute\(parsedBody\)\)/
  );
});
