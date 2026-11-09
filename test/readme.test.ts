import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extractBlock, generatedBlock } from "../scripts/gen-readme-tables.js";

it("README classification tables match the exported rule data (run `npm run docs:tables`)", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(extractBlock(readme)).toBe(await generatedBlock());
});
