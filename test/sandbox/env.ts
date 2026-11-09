import { existsSync } from "node:fs";

// Load git-ignored keys from .env.local when Node supports it (>= 20.12); otherwise
// rely on the process environment. Never print the values.
if (existsSync(".env.local") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env.local");
}

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v ? v : undefined;
}
