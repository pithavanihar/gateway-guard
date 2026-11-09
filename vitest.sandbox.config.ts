import { defineConfig } from "vitest/config";

// Sandbox smoke tests hit real gateway sandboxes. Run locally with `npm run test:sandbox`;
// CI does not run them. Keys come from a git-ignored `.env.local`.
export default defineConfig({
  test: {
    include: ["test/sandbox/**/*.smoke.ts"],
    testTimeout: 30_000,
  },
});
