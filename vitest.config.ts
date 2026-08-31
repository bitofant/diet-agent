import { defineConfig, configDefaults } from "vitest/config";

// Plain Node environment, co-located `*.test.ts`. The shared/ logic is pure
// functions — no DOM, no network, no tokens — so this gate runs in milliseconds.
//
// `*.e2e.test.ts` (live model calls) are excluded so this stays pure/fast; run
// them with `npm run test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
  },
});
