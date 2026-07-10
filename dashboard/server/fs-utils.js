import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Read a JSON file with a safe fallback for missing or malformed files.
 */
export function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

/**
 * Read a text file and return an empty string when it is unavailable.
 */
export function readText(path) {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Return the last N lines from a text file, used for live log previews.
 */
export function tailFile(path, lines) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split(/\r?\n/).slice(-Math.max(1, lines));
}

/**
 * Recursively list files and folders under a directory with lightweight metadata.
 */
export function walk(dir, depth = 0) {
  if (depth > 5 || !existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    entries.push({
      path,
      name,
      type: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
    if (stat.isDirectory()) entries.push(...walk(path, depth + 1));
  }
  return entries;
}
