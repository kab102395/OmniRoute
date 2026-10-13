import assert from "node:assert/strict";
import test from "node:test";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";

test("OpenRouter request transformation preserves the exact free route identity", () => {
  const executor = new DefaultExecutor("openrouter");
  const exactRoute = "vendor/model:free";
  const body = { model: exactRoute, messages: [{ role: "user", content: "hi" }] };

  const transformed = executor.transformRequest(exactRoute, body, false, {});

  assert.equal(transformed.model, exactRoute);
});
