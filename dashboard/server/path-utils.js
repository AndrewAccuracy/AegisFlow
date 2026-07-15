import { isAbsolute, relative, resolve } from "node:path";

export function isPathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function isSafeHistoryRunId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id) && id !== "current" && id !== "live";
}
