import { defineConfig } from "vitest/config";

// Live end-to-end tests: `*.e2e.test.ts` drive the real LLM path against the
// configured OpenAI-compatible endpoint (local vLLM by default). Kept out of the
// default `npm test` gate because they need a running endpoint; the tests
// self-skip when it is unreachable. Run: `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One local endpoint — run files serially so concurrent turns don't starve
    // each other (degrades output quality and causes timeouts).
    fileParallelism: false,
  },
});
