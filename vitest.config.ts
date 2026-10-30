import { defineConfig } from "vitest/config";

// Root tests cover the agent workspace only (fonts/render). The CRM has its
// own suite with its own DB setup: run it via `npm run test` inside crm/.
export default defineConfig({
  test: {
    include: ["agent/tests/**/*.test.ts"],
  },
});
