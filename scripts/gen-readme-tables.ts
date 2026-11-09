// Regenerates the classification tables in README.md from the exported rule data, so the
// README cannot drift from the code. Run `npm run docs:tables`; `npm test` fails if stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import {
  CASHFREE_CUSTOMER_STATUSES,
  CASHFREE_REASON_CLASSIFICATION,
  CASHFREE_SOURCE_CLASSIFICATION,
  CASHFREE_SOURCE_DECIDED_REASONS,
  RAZORPAY_CODE_CLASSIFICATION,
  RAZORPAY_REASON_CLASSIFICATION,
  RAZORPAY_SOURCE_CLASSIFICATION,
  RAZORPAY_SOURCE_DECIDED_REASONS,
} from "../src/index.js";

export const BEGIN = "<!-- BEGIN GENERATED TABLES (npm run docs:tables) -->";
export const END = "<!-- END GENERATED TABLES -->";

const cell = (s: string): string => s.replaceAll("|", "\|");

function table(headers: string[], rows: string[][]): string {
  const line = (r: string[]): string => `| ${r.map(cell).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

const code = (s: string): string => `\`${s}\``;

export function rawTables(): string {
  const reasons = (
    rules: readonly { reason: string; classification: string; description: string }[],
  ) =>
    table(
      ["Reason", "Counts as", "Meaning"],
      rules.map((r) => [code(r.reason), r.classification, r.description]),
    );
  const decided = (rules: readonly { reason: string; description: string }[]) =>
    table(
      ["Reason", "Meaning"],
      rules.map((r) => [code(r.reason), r.description]),
    );
  const sources = (rules: readonly { source: string; classification: string }[]) =>
    table(
      ["Error source", "Counts as"],
      rules.map((r) => [code(r.source), r.classification]),
    );

  return [
    "#### Razorpay",
    "",
    "Lookup order: reason table, then `error_source`, then error `code`, then `unknown`.",
    "",
    reasons(RAZORPAY_REASON_CLASSIFICATION),
    "",
    "Reasons decided by `error_source` alone (Razorpay reports them for customer and provider failures; a missing or unlisted source gives `unknown`):",
    "",
    decided(RAZORPAY_SOURCE_DECIDED_REASONS),
    "",
    "Fallback by `error_source` for reasons not listed above:",
    "",
    sources(RAZORPAY_SOURCE_CLASSIFICATION),
    "",
    "Last-resort fallback by error `code`:",
    "",
    table(
      ["Error code", "Counts as"],
      RAZORPAY_CODE_CLASSIFICATION.map((r) => [code(r.code), r.classification]),
    ),
    "",
    "#### Cashfree",
    "",
    `Lookup order: payment status (${CASHFREE_CUSTOMER_STATUSES.map(code).join(", ")} are always \`customer\`), then the reason table, then \`error_source\`, then \`unknown\`.`,
    "",
    reasons(CASHFREE_REASON_CLASSIFICATION),
    "",
    "Reasons decided by `error_source` alone (Cashfree reports them with conflicting sources):",
    "",
    decided(CASHFREE_SOURCE_DECIDED_REASONS),
    "",
    "Fallback by `error_source` for reasons not listed above:",
    "",
    sources(CASHFREE_SOURCE_CLASSIFICATION),
    "",
  ].join("\n");
}

/** The generated block, formatted the way `prettier --check` expects. */
export async function generatedBlock(): Promise<string> {
  const body = await format(rawTables(), { parser: "markdown", printWidth: 100 });
  return `${BEGIN}\n\n${body.trimEnd()}\n\n${END}`;
}

export function extractBlock(readme: string): string {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1)
    throw new Error("README.md is missing the generated-table markers");
  return readme.slice(start, end + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = new URL("../README.md", import.meta.url);
  const readme = readFileSync(path, "utf8");
  writeFileSync(path, readme.replace(extractBlock(readme), await generatedBlock()));
  console.log("README.md tables regenerated");
}
