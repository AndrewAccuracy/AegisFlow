import { existsSync, readFileSync } from "node:fs";

/**
 * Load simple KEY=VALUE pairs from a local .env file into process.env.
 * Existing environment variables win, so shell-provided secrets are not overwritten.
 */
export function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unwrapEnvValue(rawValue.trim());
  }
}

/**
 * Remove optional shell-style quotes from an env value.
 */
function unwrapEnvValue(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
