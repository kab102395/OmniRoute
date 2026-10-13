import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    pool: "threads",
    maxWorkers: 20,
    fileParallelism: true,
    maxConcurrency: 20,
    include: [
      "open-sse/mcp-server/__tests__/**/*.test.ts",
      "open-sse/services/autoCombo/__tests__/**/*.test.ts",
      "open-sse/services/combo/__tests__/**/*.test.ts",
      "open-sse/services/__tests__/antigravity-quota-family.test.ts",
      // #8890 shipped this suite into a directory no runner collects, so it had
      // never executed once (check:test-discovery flags it as a NEW orphan).
      "open-sse/services/__tests__/fail-fast-concurrency-gate.test.ts",
      "src/lib/memory/__tests__/generic-backend.test.ts",
      "tests/unit/autoCombo/**/*.test.ts",
      "tests/unit/api/**/*.spec.ts",
      "tests/unit/encryption.spec.ts",
      "src/shared/components/**/*.test.tsx",
      "src/shared/hooks/__tests__/**/*.test.tsx",
      "src/app/(dashboard)/**/__tests__/**/*.test.tsx",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      // These tests use node:test and are run by `npm run test:unit`; the broad
      // autoCombo include exists for Vitest suites and must not collect them.
      "tests/unit/autoCombo/paid-model-filter-6512.test.ts",
      "tests/unit/autoCombo/resilience-candidate-filter-status.test.ts",
    ],
    coverage: {
      reportsDirectory: "coverage",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Mirrors tsconfig paths. Without it, a UI test importing from open-sse
      // resolves to undefined instead of failing loudly — which silently made
      // every provider look credentialed in the free-tier card tests.
      "@omniroute/open-sse": path.resolve(__dirname, "./open-sse"),
    },
  },
});
