import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/env-loader.js";
import { createArchiveStore } from "./server/archives.js";
import { readJson } from "./server/fs-utils.js";
import { createStaticFileHandler, json, readBody } from "./server/http.js";
import { isPathInside, isSafeHistoryRunId } from "./server/path-utils.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
loadEnvFile(join(rootDir, ".env"));
const penDir = join(rootDir, ".pen-agent");
const artifactDir = join(rootDir, "artifacts");
const historyDir = join(rootDir, "history");
const legacyArchiveDir = join(rootDir, "归档");
const historyIndexPath = join(historyDir, "runs.json");
const webDist = join(__dirname, "web", "dist");
const port = Number(process.env.DASHBOARD_PORT || 3000);
const host = process.env.DASHBOARD_HOST || "127.0.0.1";
let activeRun = null;
const staticFile = createStaticFileHandler(webDist);
const archives = createArchiveStore({
  historyDir,
  legacyArchiveDir,
  livePenDir: penDir,
  liveArtifactDir: artifactDir,
  listHistory,
});

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/health") return json(res, { ok: true, time: new Date().toISOString() });
    if (url.pathname === "/api/config") return json(res, runtimeConfigStatus());
    if (url.pathname === "/api/archives" && req.method === "GET") return json(res, archives.archiveState());
    if (url.pathname === "/api/archives/select" && req.method === "POST") return readBody(req).then((body) => selectArchive(body, res)).catch((err) => json(res, { error: err.message }, 400));
    if (url.pathname === "/api/run" && req.method === "GET") return json(res, runStatus());
    if (url.pathname === "/api/run" && req.method === "POST") return readBody(req).then((body) => startRun(body, res)).catch((err) => json(res, { error: err.message }, 400));
    if (url.pathname === "/api/run/stop" && req.method === "POST") return stopRun(res);
    if (url.pathname === "/api/run/resume-current" && req.method === "POST") return readBody(req).then((body) => resumeCurrentRun(body, res)).catch((err) => json(res, { error: err.message }, 400));
    if (url.pathname === "/api/history" && req.method === "GET") return json(res, listHistory());
    if (url.pathname === "/api/history" && req.method === "DELETE") return deleteHistoryRun(url.searchParams.get("id") || "", res);
    if (url.pathname === "/api/state") return json(res, readState(pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/status") {
      const paths = pathsForRun(url.searchParams.get("runId"));
      return json(res, readStatus(paths));
    }
    if (url.pathname === "/api/flags") return json(res, enrichFlags(pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/logs/tail") {
      const paths = pathsForRun(url.searchParams.get("runId"));
      return json(res, { lines: tailFile(join(paths.penDir, "stream.log"), Number(url.searchParams.get("lines") || 120)) });
    }
    if (url.pathname === "/api/artifacts") return json(res, listArtifacts(pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/notes") return json(res, listNotes(pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/notes/read") return json(res, readNote(url.searchParams.get("name") || "", pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/assets") return json(res, buildAssetGraph(pathsForRun(url.searchParams.get("runId"))).nodes);
    if (url.pathname === "/api/asset-graph") return json(res, buildAssetGraph(pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/teams") return json(res, buildTeamStatus(pathsForRun(url.searchParams.get("runId"))));
    if (url.pathname === "/api/report/export") return exportReport(url, res).catch((err) => json(res, { error: err.message || "report export failed" }, 500));
    if (url.pathname === "/api/requirements") return json(res, requirementStatus());
    if (url.pathname === "/api/events") return events(req, res);
    return staticFile(url.pathname, res);
  } catch (err) {
    return json(res, { error: err.message || "dashboard error" }, 500);
  }
});

server.listen(port, host, () => {
  recoverInterruptedRun();
  console.log(`[dashboard] http://${host}:${port}`);
});

function runStatus() {
  return {
    running: Boolean(activeRun),
    active: activeRun ? publicRun(activeRun) : null,
    recoverable: activeRun ? null : currentRecoverableRun(),
    recent: listHistory().slice(0, 8),
  };
}

function publicRun(run) {
  const displayArgs = maskArgs(run.args);
  return {
    id: run.id,
    pid: run.pid,
    args: displayArgs,
    command: `node ${displayArgs.join(" ")}`,
    startedAt: run.startedAt,
    endedAt: run.endedAt || null,
    exitCode: run.exitCode ?? null,
    signal: run.signal || null,
    status: run.status,
    target: run.target,
    resumedFrom: run.resumedFrom,
    recoverable: run.recoverable,
  };
}

function maskArgs(args) {
  const masked = [...args];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "--key" || masked[i] === "-k") masked[i + 1] = "******";
  }
  return masked;
}

function runtimeConfigStatus() {
  return {
    model: process.env.PEN_AGENT_MODEL || "deepseek/deepseek-v4-flash",
    agent: process.env.PEN_AGENT_AGENT || "",
    attachUrl: process.env.PEN_AGENT_ATTACH_URL || "http://localhost:4096",
    provider: process.env.PEN_AGENT_PROVIDER || "deepseek",
    hasApiKey: Boolean(process.env.PEN_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY),
  };
}

function selectArchive(body, res) {
  const id = String(body?.id || "live").trim() || "live";
  const archive = archives.selectArchive(id);
  if (!archive) return json(res, { error: "archive snapshot not found" }, 404);
  return json(res, { ok: true, archive });
}

function buildToolPath() {
  const extra = process.platform === "win32"
    ? [
        join(rootDir, "node_modules", ".bin"),
        "C:\\Windows\\System32",
        "C:\\Windows",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
        "C:\\Program Files\\Git\\cmd",
        "C:\\Program Files\\nodejs",
      ]
    : [
        join(rootDir, "node_modules", ".bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];

  const seen = new Set();
  return [process.env.PATH || "", ...extra]
    .flatMap((item) => item.split(delimiter))
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .join(delimiter);
}

function startRun(body, res) {
  if (activeRun) return json(res, { error: "agent is already running", run: publicRun(activeRun) }, 409);

  archives.resetToLive();
  archiveCurrentSnapshot();

  const { args, target } = buildAgentArgs(body || {});
  const run = launchRun(args, target, { status: "running" });
  return json(res, { ok: true, run: publicRun(run) }, 201);
}

function resumeCurrentRun(body, res) {
  if (activeRun) return json(res, { error: "agent is already running", run: publicRun(activeRun) }, 409);
  const recoverable = currentRecoverableRun();
  if (!recoverable?.recoverable) return json(res, { error: "no recoverable current run" }, 409);

  const status = readJson(join(penDir, "status.json"), {});
  const state = readState(pathsForRun());
  let args = Array.isArray(status.args) && status.args.length ? [...status.args] : buildArgsFromSnapshot(state, status);
  args = applyResumeOverrides(args, body || {});
  if (!args.includes("--resume")) args.push("--resume");

  const target = recoverable.target || targetFromArgs(args) || state._config?.target || "";
  const run = launchRun(args, target, {
    status: "running",
    resumedFrom: status.runId || status.resumedFrom || "current",
    resumeMode: "current",
  });
  return json(res, { ok: true, run: publicRun(run) }, 201);
}

function launchRun(args, target, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PATH: buildToolPath(),
    },
  });
  const run = {
    id: `${Date.now()}`,
    pid: child.pid,
    args,
    target,
    child,
    startedAt: new Date().toISOString(),
    status: options.status || "running",
    resumedFrom: options.resumedFrom || null,
  };
  activeRun = run;
  writeCurrentStatus({
    phase: "running",
    recoverable: false,
    runId: run.id,
    pid: run.pid,
    args,
    target,
    startedAt: run.startedAt,
    resumedFrom: run.resumedFrom,
    resumeMode: options.resumeMode || null,
  });
  child.on("exit", (code, signal) => {
    run.status = signal ? "interrupted" : code === 0 ? "completed" : "failed";
    run.exitCode = code;
    run.signal = signal;
    run.endedAt = new Date().toISOString();
    writeCurrentStatus({
      phase: run.status,
      recoverable: Boolean(signal || code !== 0),
      endedAt: run.endedAt,
      exitCode: code,
      signal,
    });
    archiveRunSnapshot(run);
    upsertHistory(publicRun(run));
    if (activeRun?.id === run.id) activeRun = null;
  });
  child.on("error", (err) => {
    run.status = "failed";
    run.error = err.message;
    run.endedAt = new Date().toISOString();
    writeCurrentStatus({
      phase: "failed",
      recoverable: true,
      endedAt: run.endedAt,
      error: err.message,
    });
    archiveRunSnapshot(run);
    upsertHistory(publicRun(run));
    if (activeRun?.id === run.id) activeRun = null;
  });
  return run;
}

function stopRun(res) {
  if (!activeRun) return json(res, { ok: true, stopped: false });
  const run = activeRun;
  run.status = "stopping";
  run.recoverable = true;
  writeCurrentStatus({
    phase: "stopping",
    recoverable: true,
    stoppedAt: new Date().toISOString(),
    message: "User requested stop; run can be resumed.",
  });
  run.child.kill("SIGTERM");
  setTimeout(() => {
    if (activeRun?.id === run.id) run.child.kill("SIGKILL");
  }, 5000).unref();
  return json(res, { ok: true, stopped: true, run: publicRun(run) });
}

function buildAgentArgs(body) {
  const targetUrl = String(body.targetUrl || "").trim();
  const parsed = parseTarget(targetUrl || `${body.targetHost || "127.0.0.1"}:${body.targetPort || 80}`);
  const args = ["src/index.js", "--target", parsed.host, "--port", String(parsed.port)];

  addNumberArg(args, "--flags", body.flagsNeeded, 1, 999);
  addOptionalNumberArg(args, "--max-flags", body.maxFlags, 1, 999);
  addNumberArg(args, "--max-loops", body.maxLoops, 1, 500);
  addNumberArg(args, "--min-loops", body.minLoops, 1, 500);
  addNumberArg(args, "--stop-after-stale", body.stopAfterStale, 1, 100);
  addNumberArg(args, "--proxy-port", body.proxyPort, 1, 65535);
  addStringArg(args, "--model", body.model || process.env.PEN_AGENT_MODEL, 160);
  addStringArg(args, "--agent", body.agent || process.env.PEN_AGENT_AGENT, 80);
  addStringArg(args, "--attach", body.attachUrl || process.env.PEN_AGENT_ATTACH_URL, 240);
  addStringArg(args, "--pattern", body.pattern, 240);
  addStringArg(args, "--scope", body.scopeMode || "entry-port", 40);
  if (body.allowPrivatePivot === false) args.push("--no-private-pivot");
  if (body.noAuto) args.push("--no-auto");
  addStringArg(args, "--provider", body.provider || process.env.PEN_AGENT_PROVIDER || "deepseek", 80);
  addStringArg(args, "--key", body.apiKey || process.env.PEN_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY, 512);

  return { args, target: `${parsed.host}:${parsed.port}` };
}

function buildArgsFromSnapshot(state = {}, status = {}) {
  const target = parseTarget(status.target || state._config?.target || "127.0.0.1:80");
  const args = ["src/index.js", "--target", target.host, "--port", String(target.port)];
  addArgValue(args, "--flags", state._flagsNeeded || 1);
  if (state._config?.maxFlags && state._config.maxFlags !== "unlimited") addArgValue(args, "--max-flags", state._config.maxFlags);
  addArgValue(args, "--max-loops", 8);
  addArgValue(args, "--min-loops", 1);
  addArgValue(args, "--stop-after-stale", 2);
  addArgValue(args, "--proxy-port", 9999);
  if (state._config?.scopeMode) addArgValue(args, "--scope", state._config.scopeMode);
  if (state._config?.allowPrivatePivot === false) args.push("--no-private-pivot");
  return args;
}

function applyResumeOverrides(args, body = {}) {
  const next = [...args];
  replaceNumberArg(next, "--max-loops", body.maxLoops, 1, 500);
  replaceNumberArg(next, "--min-loops", body.minLoops, 1, 500);
  replaceNumberArg(next, "--stop-after-stale", body.stopAfterStale, 1, 100);
  replaceStringArg(next, "--model", body.model, 160);
  replaceStringArg(next, "--agent", body.agent, 80);
  replaceStringArg(next, "--attach", body.attachUrl, 240);
  return next;
}

function addArgValue(args, name, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(name, String(value));
}

function replaceNumberArg(args, name, value, min, max) {
  if (value === undefined || value === null || value === "") return;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) throw new Error(`${name} is out of range`);
  replaceArg(args, name, String(Math.trunc(num)));
}

function replaceStringArg(args, name, value, maxLength) {
  const text = String(value || "").trim();
  if (!text) return;
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (/[\u0000-\u001f]/.test(text)) throw new Error(`${name} contains invalid control characters`);
  replaceArg(args, name, text);
}

function replaceArg(args, name, value) {
  const index = args.indexOf(name);
  if (index >= 0) {
    args[index + 1] = value;
    return;
  }
  args.push(name, value);
}

function targetFromArgs(args = []) {
  const host = args[args.indexOf("--target") + 1];
  const port = args[args.indexOf("--port") + 1];
  return host && port ? `${host}:${port}` : "";
}

function parseTarget(input) {
  let text = String(input || "").trim();
  if (!text) throw new Error("target is required");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const parsed = new URL(text);
  if (!parsed.hostname) throw new Error("target host is required");
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("target port is invalid");
  return { host: parsed.hostname, port };
}

function addNumberArg(args, name, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  args.push(name, String(number));
}

function addOptionalNumberArg(args, name, value, min, max) {
  if (value === null || value === undefined || value === "") return;
  addNumberArg(args, name, value, min, max);
}

function addStringArg(args, name, value, maxLength) {
  const text = String(value || "").trim();
  if (!text) return;
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (/[\u0000-\u001f]/.test(text)) throw new Error(`${name} contains invalid control characters`);
  args.push(name, text);
}

function pathsForRun(runId) {
  return archives.pathsForRun(runId);
}

function readState(paths = pathsForRun()) {
  return readJson(join(paths.penDir, "state.json"), { iteration: 0, iterations: [], _config: {}, _flagsFound: 0, _flagsNeeded: 0 });
}

function readStatus(paths = pathsForRun()) {
  const status = readJson(join(paths.penDir, "status.json"), { phase: "idle" });
  if (!paths.runId) return status;
  const run = readHistoryIndex().find((item) => item.id === paths.runId);
  if (!run) return status;
  return {
    ...status,
    phase: run.status || status.phase || "archived",
    startedAt: run.startedAt || status.startedAt,
    endedAt: run.endedAt ?? status.endedAt,
    exitCode: run.exitCode ?? status.exitCode,
    signal: run.signal || status.signal,
  };
}

function currentRecoverableRun() {
  const status = readJson(join(penDir, "status.json"), {});
  const state = readState(pathsForRun());
  const rawFlags = readJson(join(artifactDir, "flags.json"), { count: 0, flags: [] });
  const flags = normalizeFlagState(rawFlags, state, pathsForRun());
  const iterations = state.iteration || state.iterations?.length || 0;
  const hasState = iterations > 0 || flags.count > 0 || existsSync(join(penDir, "stream.log"));
  if (!hasState) return null;

  const phase = String(status.phase || "idle");
  const recoverable = Boolean(status.recoverable)
    || /^(failed|interrupted|stopping)$/i.test(phase)
    || (phase === "completed" && state._config?.maxFlags && flags.count < Number(state._config.maxFlags));
  if (!recoverable) return null;

  return {
    recoverable: true,
    phase,
    reason: status.message || (phase === "completed" ? "completed before max flags" : "stopped or interrupted"),
    target: status.target || state._config?.target || flags.target || "",
    flagsFound: flags.count || 0,
    maxFlags: state._config?.maxFlags || rawFlags.maxFlags || null,
    iterations,
    lastUpdatedAt: status.time || status.endedAt || statTime(join(penDir, "stream.log")) || null,
    runId: status.runId || null,
  };
}

function writeCurrentStatus(data) {
  const statusPath = join(penDir, "status.json");
  const previous = readJson(statusPath, {});
  mkdirSync(penDir, { recursive: true });
  writeFileSync(statusPath, JSON.stringify({
    ...previous,
    ...data,
    time: data.time || new Date().toISOString(),
  }, null, 2), "utf-8");
}

function listHistory() {
  return readHistoryIndex()
    .sort((a, b) => String(b.startedAt || b.id).localeCompare(String(a.startedAt || a.id)))
    .map((run) => ({ ...run, command: run.command || (run.args ? `node ${maskArgs(run.args).join(" ")}` : "") }));
}

function deleteHistoryRun(id, res) {
  const cleanId = String(id || "").trim();
  if (!isSafeHistoryRunId(cleanId)) {
    return json(res, { error: "invalid history id" }, 400);
  }
  const runDir = resolve(historyDir, cleanId);
  if (!isPathInside(historyDir, runDir)) return json(res, { error: "invalid history id" }, 400);
  const rows = readHistoryIndex();
  const nextRows = rows.filter((run) => run.id !== cleanId);
  const existed = nextRows.length !== rows.length || existsSync(runDir);
  writeHistoryIndex(nextRows);
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch (e) {
    return json(res, { error: `failed to delete history snapshot: ${e.message}` }, 500);
  }
  return json(res, { ok: true, deleted: existed, id: cleanId, history: listHistory() });
}

function readHistoryIndex() {
  const rows = readJson(historyIndexPath, []);
  return Array.isArray(rows) ? rows : [];
}

function writeHistoryIndex(rows) {
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(historyIndexPath, JSON.stringify(dedupeHistoryRows(rows).slice(0, 100), null, 2), "utf-8");
}

function upsertHistory(run) {
  const rows = readHistoryIndex();
  const sanitized = publicHistoryRun(run);
  const index = rows.findIndex((item) => item.id === sanitized.id || isDuplicateHistoryRun(item, sanitized));
  if (index >= 0) rows[index] = { ...rows[index], ...sanitized };
  else rows.push(sanitized);
  writeHistoryIndex(rows.sort((a, b) => String(b.startedAt || b.id).localeCompare(String(a.startedAt || a.id))));
}

function dedupeHistoryRows(rows) {
  const deduped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const index = deduped.findIndex((item) => item.id === row.id || isDuplicateHistoryRun(item, row));
    if (index >= 0) deduped[index] = preferHistoryRun(deduped[index], row);
    else deduped.push(row);
  }
  return deduped;
}

function preferHistoryRun(a, b) {
  const aManual = isSyntheticHistoryId(a.id);
  const bManual = isSyntheticHistoryId(b.id);
  if (aManual !== bManual) return aManual ? b : a;
  const aComplete = a.status === "completed";
  const bComplete = b.status === "completed";
  if (aComplete !== bComplete) return aComplete ? a : b;
  return Date.parse(b.endedAt || 0) > Date.parse(a.endedAt || 0) ? b : a;
}

function isDuplicateHistoryRun(a, b) {
  if (!a || !b) return false;
  if (String(a.id || "") === String(b.id || "")) return true;
  if (String(a.target || "") !== String(b.target || "")) return false;

  const sameProgress = Number(a.flagsFound || 0) === Number(b.flagsFound || 0)
    && Number(a.iterations || 0) === Number(b.iterations || 0)
    && String(a.summary || "") === String(b.summary || "");
  if (!sameProgress) return false;

  const aStart = Date.parse(a.startedAt || "");
  const bStart = Date.parse(b.startedAt || "");
  const aEnd = Date.parse(a.endedAt || a.startedAt || "");
  const bEnd = Date.parse(b.endedAt || b.startedAt || "");
  if (![aStart, bStart, aEnd, bEnd].every(Number.isFinite)) return false;

  const windowsOverlap = aStart <= bEnd && bStart <= aEnd;
  const endsClose = (isSyntheticHistoryId(a.id) || isSyntheticHistoryId(b.id))
    && Math.abs(aEnd - bEnd) <= 5 * 60 * 1000;
  return windowsOverlap || endsClose;
}

function isSyntheticHistoryId(id) {
  return /^(manual|interrupted)-/.test(String(id || ""));
}

function publicHistoryRun(run) {
  const state = readState(pathsForRun(run.id));
  const rawFlags = readJson(join(historyDir, run.id, "artifacts", "flags.json"), { count: 0, flags: [] });
  const flags = normalizeFlagState(rawFlags, state, pathsForRun(run.id));
  return {
    id: String(run.id),
    pid: run.pid,
    args: run.args ? maskArgs(run.args) : undefined,
    command: run.command,
    startedAt: run.startedAt,
    endedAt: run.endedAt || null,
    exitCode: run.exitCode ?? null,
    signal: run.signal || null,
    status: run.status || "archived",
    target: run.target || state._config?.target || flags.target || "",
    flagsFound: flags.count || 0,
    iterations: state.iteration || state.iterations?.length || 0,
    summary: state.iterations?.at(-1)?.summary || "",
  };
}

function recoverInterruptedRun() {
  if (activeRun) return;
  const status = readJson(join(penDir, "status.json"), {});
  const hasResidualRun = /^(running|stopping)$/i.test(String(status.phase || ""));
  if (!hasResidualRun) return;

  const archived = archiveCurrentSnapshot({ status: "interrupted", idPrefix: "interrupted" });
  if (!archived) return;

  writeFileSync(join(penDir, "status.json"), JSON.stringify({
    ...status,
    phase: "interrupted",
    recoveredAt: new Date().toISOString(),
  }, null, 2), "utf-8");
  console.log("[dashboard] recovered interrupted run into history");
}

function archiveCurrentSnapshot(options = {}) {
  if (activeRun) return;
  const statePath = join(penDir, "state.json");
  const logPath = join(penDir, "stream.log");
  if (!existsSync(statePath) && !existsSync(logPath)) return false;

  const state = readState(pathsForRun());
  const startedAt = state.iterations?.[0]?.time || statTime(statePath) || statTime(logPath) || new Date().toISOString();
  const target = state._config?.target || "";
  const prefix = options.idPrefix || "manual";
  const id = `${prefix}-${String(startedAt).replace(/[^0-9A-Za-z]/g, "").slice(0, 32) || Date.now()}`;
  const currentFlags = normalizeFlagState(readJson(join(artifactDir, "flags.json"), { count: 0, flags: [] }), state, pathsForRun());
  const snapshot = {
    id,
    startedAt,
    endedAt: statTime(logPath) || new Date().toISOString(),
    target,
    flagsFound: currentFlags.count || 0,
    iterations: state.iteration || state.iterations?.length || 0,
    summary: state.iterations?.at(-1)?.summary || "",
  };
  const existing = readHistoryIndex().find((item) => item.id === id || isDuplicateHistoryRun(item, snapshot));
  if (existing) return false;

  const run = {
    id,
    startedAt,
    endedAt: snapshot.endedAt,
    status: options.status || "archived",
    target,
  };
  archiveRunSnapshot(run);
  upsertHistory(run);
  return true;
}

function archiveRunSnapshot(run) {
  if (!run?.id || !/^[A-Za-z0-9_.-]{1,80}$/.test(String(run.id))) return;
  const base = join(historyDir, String(run.id));
  const runPenDir = join(base, ".pen-agent");
  const runArtifactDir = join(base, "artifacts");

  mkdirSync(base, { recursive: true });
  copyDirIfExists(penDir, runPenDir);
  copyDirIfExists(artifactDir, runArtifactDir);
  mkdirSync(runPenDir, { recursive: true });
  mkdirSync(runArtifactDir, { recursive: true });
  writeSnapshotStatus(run, join(runPenDir, "status.json"));

  const snapshotRun = publicHistoryRun(run);
  writeFileSync(join(base, "run.json"), JSON.stringify(snapshotRun, null, 2), "utf-8");
}

function writeSnapshotStatus(run, statusPath) {
  const previous = readJson(statusPath, {});
  writeFileSync(statusPath, JSON.stringify({
    ...previous,
    phase: run.status || previous.phase || "archived",
    startedAt: run.startedAt || previous.startedAt || null,
    endedAt: run.endedAt || previous.endedAt || null,
    exitCode: run.exitCode ?? previous.exitCode ?? null,
    signal: run.signal || previous.signal || null,
    recoveredAt: run.status === "interrupted" ? new Date().toISOString() : previous.recoveredAt,
  }, null, 2), "utf-8");
}

function copyDirIfExists(from, to) {
  try {
    if (!existsSync(from)) return;
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true });
  } catch (e) {
    console.error(`[dashboard] failed to copy history dir ${from}: ${e.message}`);
  }
}

function statTime(path) {
  try {
    if (!existsSync(path)) return "";
    return statSync(path).mtime.toISOString();
  } catch {
    return "";
  }
}

function tailFile(path, lines) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split(/\r?\n/).slice(-Math.max(1, lines));
}

function listArtifacts(paths = pathsForRun()) {
  if (!existsSync(paths.artifactDir)) return [];
  return walk(paths.artifactDir).map((item) => ({ ...item, path: item.path.replace(`${paths.artifactDir}/`, "") }));
}

function listNotes(paths = pathsForRun()) {
  const notesDir = join(paths.artifactDir, "notes");
  if (!existsSync(notesDir)) return [];
  return readdirSync(notesDir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => {
      const path = join(notesDir, name);
      const stat = statSync(path);
      return {
        name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    });
}

function readNote(name, paths = pathsForRun()) {
  if (!/^[A-Za-z0-9_.-]+\.md$/.test(name)) throw new Error("invalid note name");
  const notesDir = join(paths.artifactDir, "notes");
  const filePath = resolve(notesDir, name);
  if (!isPathInside(notesDir, filePath) || !existsSync(filePath)) throw new Error("note not found");
  return {
    name,
    content: readFileSync(filePath, "utf-8"),
    updatedAt: statSync(filePath).mtime.toISOString(),
  };
}

async function exportReport(url, res) {
  const paths = pathsForRun(url.searchParams.get("runId"));
  const { markdown, filename } = buildWjsReport(paths);
  const format = String(url.searchParams.get("format") || "pdf").toLowerCase();

  if (format === "md" || format === "markdown") {
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    });
    res.end(markdown);
    return;
  }

  const pdf = await renderReportPdf(markdown);
  const pdfFilename = filename.replace(/\.md$/i, ".pdf");
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${pdfFilename}"`,
    "Cache-Control": "no-store",
  });
  res.end(pdf);
}

async function renderReportPdf(markdown) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(buildReportHtml(markdown), { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      margin: { top: "18mm", right: "14mm", bottom: "16mm", left: "14mm" },
      headerTemplate: "<span></span>",
      footerTemplate: [
        '<div style="width:100%;font-size:8px;color:#6e7076;padding:0 14mm;font-family:Georgia,Times New Roman,serif;">',
        '<span>AegisFlow Authorized Lab Report</span>',
        '<span style="float:right;"><span class="pageNumber"></span> / <span class="totalPages"></span></span>',
        "</div>",
      ].join(""),
    });
  } finally {
    await browser.close();
  }
}

function buildReportHtml(markdown) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    :root {
      --ink: #4f5054;
      --brand: #073846;
      --muted: #6e7076;
      --line: #d7d8db;
      --lemon-icing: #f5edc6;
      --nimbus-cloud: #d7d8db;
      --raindrops-on-roses: #eadde1;
      --cloud-dancer: #f1f0ec;
      --ice-melt: #d5e4f1;
      --peach-dust: #ead8ca;
      --almost-aqua: #cbd6c4;
      --orchid-tint: #d8d2dc;
    }

    @page {
      size: A4;
      margin: 18mm 14mm 16mm;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--ink);
      background: #fff;
      font-family: Georgia, "Times New Roman", "Noto Serif CJK SC", "Songti SC", SimSun, serif;
      font-size: 11px;
      line-height: 1.62;
    }

    .report {
      position: relative;
    }

    .report::before {
      content: none;
    }

    .masthead {
      margin: 0 0 14px;
      padding: 0 0 8px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      color: var(--brand);
      text-align: center;
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-size: 30px;
      font-weight: 500;
      letter-spacing: 0;
    }

    h1, h2, h3 {
      margin: 0;
      color: var(--brand);
      font-weight: 500;
      page-break-after: avoid;
    }

    h1 {
      min-height: 0;
      padding: 10mm 0 5mm;
      text-align: center;
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-size: 34px;
      font-weight: 500;
      letter-spacing: 0;
    }

    h2 {
      margin-top: 20px;
      padding: 9px 0 6px;
      border-top: 1px solid var(--line);
      font-size: 16px;
    }

    h3 {
      margin-top: 14px;
      font-size: 13px;
    }

    p {
      margin: 8px 0;
    }

    blockquote {
      margin: 0 auto 14mm;
      max-width: 148mm;
      padding: 7px 10px;
      border: 0;
      background: var(--lemon-icing);
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    table {
      width: 100%;
      margin: 8px 0 13px;
      border-collapse: collapse;
      page-break-inside: auto;
      background: #fff;
    }

    tr {
      page-break-inside: avoid;
      page-break-after: auto;
    }

    th,
    td {
      padding: 6px 7px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }

    th {
      color: var(--ink);
      background: var(--ice-melt);
      font-weight: 600;
    }

    table:nth-of-type(3n + 1) th {
      background: var(--lemon-icing);
    }

    table:nth-of-type(3n + 2) th {
      background: var(--almost-aqua);
    }

    table:nth-of-type(3n) th {
      background: var(--raindrops-on-roses);
    }

    ul {
      margin: 8px 0 12px;
      padding-left: 16px;
    }

    li {
      margin: 3px 0;
    }

    pre {
      margin: 8px 0 12px;
      padding: 8px 10px;
      color: var(--ink);
      background: rgba(213, 228, 241, 0.52);
      border-left: 3px solid var(--peach-dust);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 9px;
    }

    strong {
      color: var(--ink);
      font-weight: 700;
    }

    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
  </style>
</head>
<body>
  <main class="report">
    <div class="masthead">AegisFlow</div>
    ${markdownToHtml(markdown)}
  </main>
</body>
</html>`;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    if (line.startsWith("```")) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\|.*\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s:-]+\|/.test(lines[i + 1].trim())) {
      const tableLines = [line];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      html.push(reportMarkdownTableToHtml(tableLines));
      continue;
    }

    if (line.startsWith("# ")) {
      html.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      html.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      html.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("> ")) {
      const quoteLines = [line.slice(2)];
      while (i + 1 < lines.length && lines[i + 1].startsWith("> ")) {
        i += 1;
        quoteLines.push(lines[i].slice(2));
      }
      html.push(`<blockquote>${quoteLines.map(inlineMarkdown).join("<br>")}</blockquote>`);
      continue;
    }
    if (line.startsWith("- ")) {
      const items = [line.slice(2)];
      while (i + 1 < lines.length && lines[i + 1].startsWith("- ")) {
        i += 1;
        items.push(lines[i].slice(2));
      }
      html.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    const paragraph = [line];
    while (
      i + 1 < lines.length
      && lines[i + 1].trim()
      && !/^(#{1,3} |> |- |\||```)/.test(lines[i + 1])
    ) {
      i += 1;
      paragraph.push(lines[i]);
    }
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return html.join("\n");
}

function reportMarkdownTableToHtml(lines) {
  const rows = lines.map(splitReportMarkdownRow);
  const headers = rows[0] || [];
  const bodyRows = rows.slice(1);
  return [
    "<table>",
    `<thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`,
    `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table>",
  ].join("");
}

function splitReportMarkdownRow(line) {
  const cells = [];
  let current = "";
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "|" && text[i - 1] !== "\\") {
      cells.push(current.trim().replace(/\\\|/g, "|"));
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim().replace(/\\\|/g, "|"));
  return cells;
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildWjsReport(paths = pathsForRun()) {
  const state = readState(paths);
  const status = readStatus(paths);
  const flags = enrichFlags(paths);
  const graph = buildAssetGraph(paths);
  const teams = buildTeamStatus(paths);
  const notes = listNotes(paths);
  const iterations = state.iterations || [];
  const target = flags.target || state._config?.target || status.target || "unknown-target";
  const generatedAt = new Date().toISOString();
  const hosts = uniqueReportValues([
    ...iterations.flatMap((item) => item.hosts || []),
    ...graph.nodes.map((node) => node.id),
  ]).filter((item) => item && item !== "unknown-target");
  const services = uniqueReportValues(iterations.flatMap((item) => (item.services || []).map((service) => `${service.host || "?"}:${service.port || "?"}${service.name ? ` ${service.name}` : ""}`)));
  const credentials = uniqueReportValues(iterations.flatMap((item) => (item.credentials || []).map(formatReportCredential)).filter(Boolean));
  const problems = iterations.flatMap((item) => (item.problems || []).map((problem) => ({ iter: item.iter, ...problem })));
  const toolCalls = iterations.flatMap((item) => (item.toolCalls || []).map((call) => ({ iter: item.iter, ...call })));
  const latest = iterations.at(-1) || {};
  const lines = [
    "# 授权安全评估报告",
    "",
    "> AegisFlow 一键导出，WJS 风格报告骨架。仅用于授权靶场与合规安全评估场景。",
    "",
    "## 0. 报告信息",
    "",
    reportTable(["项目", "内容"], [
      ["目标", target],
      ["数据源", archives.archiveState().selectedLabel || archives.archiveState().selected || "实时数据"],
      ["生成时间", generatedAt],
      ["运行状态", status.phase || "unknown"],
      ["攻击轮次", String(iterations.length)],
      ["Flag 进度", `${flags.count || 0}/${flags.flagsNeeded || state._flagsNeeded || "?"}`],
      ["发现资产", `${hosts.length} 主机 / ${services.length} 服务 / ${credentials.length} 凭据`],
    ]),
    "",
    "## 1. 执行摘要",
    "",
    latest.summary ? reportParagraph(latest.summary) : "暂无最终摘要，建议在完成运行后重新导出。",
    "",
    `本次评估共完成 ${iterations.length} 轮自动化分析，识别 ${hosts.length} 个主机线索、${services.length} 个服务线索、${credentials.length} 条凭据线索，取得 ${flags.count || 0} 个 flag。`,
    "",
    "## 2. 范围与边界",
    "",
    reportTable(["范围项", "说明"], [
      ["入口目标", target],
      ["入口策略", state._config?.scopeMode || "entry-port"],
      ["私网横向", state._config?.allowPrivatePivot === false ? "关闭" : "允许入口打通后的私网横向"],
      ["模型", state._config?.model || process.env.PEN_AGENT_MODEL || "未记录"],
      ["停止条件", `目标 flag ${flags.flagsNeeded || state._flagsNeeded || "?"}，最大轮次 ${state._config?.maxLoops || "未记录"}`],
    ]),
    "",
    "## 3. 资产与拓扑",
    "",
    graph.nodes.length ? reportTable(["资产", "区域", "状态", "服务", "Flag"], graph.nodes.map((node) => [
      node.name || node.id,
      node.inferredZone || "-",
      node.status || "-",
      (node.services || []).map((service) => `${service.port || "?"}/${service.name || "unknown"}`).join(", ") || "-",
      node.flagFound ? "是" : "否",
    ])) : "暂无资产图谱数据。",
    "",
    graph.edges.length ? reportTable(["来源", "目标", "关系", "轮次", "证据"], graph.edges.slice(0, 40).map((edge) => [
      edge.from,
      edge.to,
      edge.type,
      edge.iter ?? "-",
      edge.evidence || "-",
    ])) : "暂无拓扑边数据。",
    "",
    "## 4. 攻击过程时间线",
    "",
    iterations.length ? reportTable(["轮次", "时间", "阶段/位置", "摘要", "产出"], iterations.map((item) => [
      `R${item.iter}`,
      item.time || "-",
      item.position || "-",
      item.summary || "-",
      [`flags ${item.flags?.length || 0}`, `hosts ${item.hosts?.length || 0}`, `tools ${item.toolCalls?.length || 0}`].join(" / "),
    ])) : "暂无轮次数据。",
    "",
    "## 5. 主要发现",
    "",
    iterations.length ? iterations.map(formatReportFinding).join("\n\n") : "暂无发现数据。",
    "",
    "## 6. Flag 与证据链",
    "",
    flags.flags?.length ? reportTable(["序号", "Flag", "轮次", "利用方式", "证据摘要"], flags.flags.map((flag) => [
      String(flag.index),
      flag.value,
      flag.evidence?.iter ?? flag.iter ?? "-",
      flag.evidence?.method || "-",
      flag.evidence?.exploitSummary || flag.evidence?.summary || "-",
    ])) : "暂无 flag 数据。",
    "",
    flags.flags?.some((flag) => flag.evidence?.command) ? [
      "### 6.1 关键取证命令",
      "",
      ...flags.flags.filter((flag) => flag.evidence?.command).map((flag) => [
        `**${flag.value}**`,
        "",
        "```bash",
        flag.evidence.command,
        "```",
      ].join("\n")),
    ].join("\n") : "",
    "",
    "## 7. 工具调用摘要",
    "",
    toolCalls.length ? reportTable(["轮次", "工具", "目的", "命令/请求", "结果影响"], toolCalls.slice(0, 80).map((call) => [
      `R${call.iter}`,
      call.tool || "shell",
      call.purpose || "-",
      call.command || "-",
      call.impact || call.result || "-",
    ])) : "暂无工具调用记录。",
    "",
    "## 8. 风险与修复建议",
    "",
    problems.length ? reportTable(["轮次", "现象", "原因", "处置/建议"], problems.map((problem) => [
      `R${problem.iter}`,
      problem.symptom || "-",
      problem.cause || "-",
      problem.resolution || "建议补充验证并制定修复方案。",
    ])) : [
      "- 对入口 Web 服务、管理面、对象存储、数据库与协议型服务执行最小暴露原则。",
      "- 对已发现凭据执行轮换，排查复用、默认口令与明文配置。",
      "- 对可被利用的 RCE、路径穿越、配置写入、对象存储授权链路进行补丁与访问控制修复。",
      "- 将本报告中的关键命令纳入回归验证，修复后复测 flag 路径是否失效。",
    ].join("\n"),
    "",
    "## 9. 协作交接",
    "",
    teams.teams?.length ? reportTable(["团队", "关注点", "状态", "输出"], teams.teams.map((team) => [
      team.name,
      team.focus,
      team.status,
      (team.outputs || []).join("; ") || "-",
    ])) : "暂无协作数据。",
    "",
    "## 10. 附录",
    "",
    "### 10.1 笔记文件",
    "",
    notes.length ? reportTable(["文件", "大小", "更新时间"], notes.map((note) => [note.name, `${note.size} B`, note.updatedAt])) : "暂无笔记文件。",
    "",
    "### 10.2 原始统计",
    "",
    reportTable(["指标", "值"], [
      ["主机线索", String(hosts.length)],
      ["服务线索", String(services.length)],
      ["凭据线索", String(credentials.length)],
      ["工具调用", String(toolCalls.length)],
      ["问题/阻塞", String(problems.length)],
    ]),
    "",
  ].flat().filter((line) => line !== null && line !== undefined).join("\n");

  return {
    markdown: lines.replace(/\n{3,}/g, "\n\n"),
    filename: `aegisflow-wjs-report-${safeReportFilename(target)}-${generatedAt.slice(0, 10)}.md`,
  };
}

function formatReportFinding(item) {
  const chunks = [
    `### R${item.iter} ${item.position || "阶段发现"}`,
    "",
    item.summary || "暂无摘要。",
    "",
    reportTable(["类别", "内容"], [
      ["主机", (item.hosts || []).join(", ") || "-"],
      ["服务", (item.services || []).map((service) => `${service.host || "?"}:${service.port || "?"}${service.name ? ` ${service.name}` : ""}`).join("; ") || "-"],
      ["凭据", (item.credentials || []).map(formatReportCredential).filter(Boolean).join("; ") || "-"],
      ["情报", (item.intel || []).join("; ") || "-"],
      ["Flag", (item.flags || []).join("; ") || "-"],
      ["阻塞", (item.problems || []).map((problem) => problem.symptom || problem.cause).filter(Boolean).join("; ") || "-"],
      ["下一步", (item.nextSteps || []).join("; ") || "-"],
    ]),
  ];
  return chunks.join("\n");
}

function reportTable(headers, rows) {
  const normalizedRows = rows.length ? rows : [headers.map(() => "-")];
  return [
    `| ${headers.map(reportCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...normalizedRows.map((row) => `| ${row.map(reportCell).join(" | ")} |`),
  ].join("\n");
}

function reportCell(value) {
  const text = String(value ?? "-").replace(/\s+/g, " ").trim() || "-";
  return text.replace(/\|/g, "\\|").slice(0, 360);
}

function reportParagraph(value) {
  return String(value || "").trim().replace(/\n{3,}/g, "\n\n");
}

function uniqueReportValues(values) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function formatReportCredential(credential) {
  if (!credential) return "";
  const username = String(credential.username || "").trim();
  const password = String(credential.password || "").trim();
  const host = String(credential.host || credential.service || "").trim();
  if (!username && !password && !host) return "";
  const account = password ? `${username || "?"}:${password}` : username || "?";
  return host ? `${account} @ ${host}` : account;
}

function safeReportFilename(value) {
  return String(value || "target")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "target";
}

function walk(dir, depth = 0) {
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

function enrichFlags(paths = pathsForRun()) {
  const rawFlags = readJson(join(paths.artifactDir, "flags.json"), { count: 0, flags: [], updatedAt: null });
  const state = readState(paths);
  const logLines = tailFile(join(paths.penDir, "stream.log"), 500);
  const flags = normalizeFlagState(rawFlags, state, paths);
  if (!paths.readonly) syncFlagFiles(flags, paths);
  return {
    ...flags,
    flags: (flags.flags || []).map((flag) => ({
      ...flag,
      evidence: findFlagEvidence(flag.value, state, logLines, flag),
    })),
  };
}

function normalizeFlagState(rawFlags, state, paths = pathsForRun()) {
  const values = [];
  const metadata = new Map();
  const rememberFlag = (value, patch = {}) => {
    if (!value) return;
    values.push(value);
    metadata.set(value, { ...(metadata.get(value) || {}), ...patch });
  };
  for (const item of rawFlags.flags || []) {
    if (typeof item === "string") rememberFlag(item);
    else if (item?.value) rememberFlag(item.value, item);
    else if (item?.flag) rememberFlag(item.flag, { ...item, value: item.flag });
  }

  try {
    const text = readFileSync(join(paths.artifactDir, "flags.txt"), "utf-8");
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) rememberFlag(line);
  } catch {}

  for (const iter of state.iterations || []) {
    for (const flag of iter.flags || []) rememberFlag(flag, { iter: iter.iter });
    for (const item of iter.flagEvidence || []) {
      const value = item.value || item.flag;
      rememberFlag(value, {
        iter: iter.iter,
        source: item.hostId || item.host || item.serviceId || "structured evidence",
        hostId: item.hostId,
        serviceId: item.serviceId,
        path: item.path,
        method: item.method,
        via: item.via,
        command: item.command,
        evidence: item.evidence,
        confidence: item.confidence,
      });
    }
  }

  const unique = [...new Set(values.filter(Boolean))];
  const config = state._config || {};
  return {
    target: rawFlags.target || config.target || "unknown-target",
    targetHost: rawFlags.targetHost,
    targetPort: rawFlags.targetPort,
    flagsNeeded: rawFlags.flagsNeeded || state._flagsNeeded || 0,
    maxFlags: rawFlags.maxFlags ?? config.maxFlags ?? null,
    count: unique.length,
    updatedAt: rawFlags.updatedAt || new Date().toISOString(),
    loopsUsed: rawFlags.loopsUsed ?? null,
    flags: unique.map((value, index) => ({
      index: index + 1,
      value,
      ...metadata.get(value),
    })),
  };
}

function syncFlagFiles(flags, paths = pathsForRun()) {
  try {
    writeFileSync(join(paths.artifactDir, "flags.json"), JSON.stringify(flags, null, 2));
    writeFileSync(join(paths.artifactDir, "flags.txt"), flags.flags.length ? `${flags.flags.map((item) => item.value).join("\n")}\n` : "");
  } catch (e) {
    console.error(`[dashboard] failed to sync flag files: ${e.message}`);
  }
}

function findFlagEvidence(flag, state, logLines, normalized = {}) {
  if (normalized.method || normalized.command || normalized.evidence || normalized.hostId || normalized.serviceId) {
    const method = normalizeExploitMethod(normalized.method, `${flag}\n${normalized.command || ""}\n${normalized.evidence || ""}\n${normalized.path || ""}`);
    return {
      iter: normalized.iter ?? null,
      method,
      summary: [normalized.hostId || normalized.serviceId, normalized.path, normalized.evidence].filter(Boolean).join("；") || "来自结构化 flagEvidence",
      command: normalized.command || "",
      hostId: normalized.hostId,
      serviceId: normalized.serviceId,
      confidence: normalized.confidence,
      exploitSummary: describeFlagExploit(method, flag, `${normalized.command || ""}\n${normalized.evidence || ""}\n${normalized.path || ""}`),
    };
  }
  for (const iter of state.iterations || []) {
    const structured = (iter.flagEvidence || []).find((item) => (item.value || item.flag) === flag);
    if (structured) {
      const method = normalizeExploitMethod(structured.method, `${flag}\n${structured.command || ""}\n${structured.evidence || ""}\n${structured.path || ""}`);
      return {
        iter: iter.iter,
        method,
        summary: [structured.hostId || structured.serviceId, structured.path, structured.evidence].filter(Boolean).join("；"),
        command: structured.command || "",
        hostId: structured.hostId,
        serviceId: structured.serviceId,
        confidence: structured.confidence,
        exploitSummary: describeFlagExploit(method, flag, `${structured.command || ""}\n${structured.evidence || ""}\n${structured.path || ""}`),
      };
    }
    const related = findRelatedFlagEvidence(iter, flag);
    if (related) {
      const method = normalizeExploitMethod(related.method, `${flag}\n${related.command || ""}\n${related.summary || ""}`);
      return {
        iter: iter.iter,
        method,
        summary: related.summary,
        command: related.command,
        exploitSummary: describeFlagExploit(method, flag, `${related.command || ""}\n${related.summary || ""}`),
      };
    }
    if ((iter.flags || []).includes(flag)) {
      const summary = summarizeFlagFromIteration(iter, flag);
      const method = normalizeExploitMethod("", `${flag}\n${summary}\n${findRelatedCommand(iter, flag)}`);
      return {
        iter: iter.iter,
        method,
        summary,
        command: "",
        exploitSummary: describeFlagExploit(method, flag, summary),
      };
    }
  }
  const line = logLines.find((item) => item.includes(flag));
  if (line) {
    const method = normalizeExploitMethod("", `${flag}\n${line}`);
    return { iter: null, method, summary: line.slice(0, 240), command: "", exploitSummary: describeFlagExploit(method, flag, line) };
  }
  const method = normalizeExploitMethod("", flag);
  return { iter: null, method, summary: "flag 已流式写入，来源命令待后续结构化补充", command: "", exploitSummary: describeFlagExploit(method, flag, "") };
}

function normalizeExploitMethod(method = "", evidence = "") {
  const value = String(method || "").trim();
  if (value && !/^(curl|tool|bash|python|stream|supervisor|structured).*(output|extraction|evidence|file)?$/i.test(value)) return value;
  return inferFlagMethod(evidence);
}

function describeFlagExploit(method, flag, evidence = "") {
  const text = `${method}\n${flag}\n${evidence}`;
  const known = [
    [/sentinel_git|GitLab ExifTool RCE|gitlab|exiftool|CVE-2021-22205/i, "利用 GitLab 13.10.x ExifTool 上传解析 RCE，将 /flag.txt 写入 public 可访问路径后从入口读取。"],
    [/sentinel_object|MinIO bootstrap env|minio|sigv4|presigned|bootstrap/i, "利用 MinIO bootstrap/环境信息泄露获得对象存储凭据，生成 SigV4 预签名 URL 后通过入口读取 flag 对象。"],
    [/sentinel_wiki|Solr Velocity RCE|solr|velocity/i, "利用 Apache Solr VelocityResponseWriter 模板注入执行命令，在 wiki/Solr 主机上读取 /flag.txt。"],
    [/sentinel_cache|CouchDB config command chain|couchdb|_config/i, "利用 CouchDB 管理接口/配置写入链触发命令执行，在 cache/CouchDB 主机上读取 flag。"],
    [/sentinel_files|ProFTPD mod_copy|proftpd|mod_?copy|SITE CPFR|ftp/i, "利用 ProFTPD mod_copy/FTP 文件复制能力把受限路径中的 flag 复制到可读取目录后下载。"],
    [/sentinel_dmz|Apache path traversal\/CGI|httpd|icons|cgi/i, "利用 Apache HTTPD 2.4.50 路径穿越读取目标文件；可用 CGI /bin/sh 时通过入口 RCE 执行目标侧命令取证。"],
  ];
  for (const [pattern, summary] of known) {
    if (pattern.test(text)) return summary;
  }
  return "通过已获授权的远程命令、HTTP 响应或目标服务协议输出取得 flag；具体漏洞类型待结构化证据补充。";
}

function findRelatedFlagEvidence(iter, flag) {
  for (const call of iter.toolCalls || []) {
    const text = `${call.command || ""}\n${call.result || ""}\n${call.impact || ""}`;
    if (!text.includes(flag)) continue;
    return {
      method: call.tool ? `${call.tool} output` : "tool output",
      summary: summarizeFlagToolCall(call, flag),
      command: call.command || "",
    };
  }
  return null;
}

function findRelatedCommand(iter, flag) {
  for (const call of iter.toolCalls || []) {
    const text = `${call.command || ""}\n${call.result || ""}\n${call.impact || ""}`;
    if (text.includes(flag)) return call.command || "";
  }
  return "";
}

function summarizeFlagToolCall(call, flag) {
  const pieces = [];
  if (call.purpose) pieces.push(`目的：${call.purpose}`);
  if (call.result) pieces.push(`结果：${clipTextAroundFlag(call.result, flag, 220)}`);
  if (call.impact) pieces.push(`影响：${call.impact}`);
  if (!pieces.length) pieces.push(`命令输出中出现 ${flag}`);
  return pieces.join("；");
}

function summarizeFlagFromIteration(iter, flag) {
  const snippets = [
    ...(iter.analysisTrail || []).flatMap((item) => [item.evidence, item.decision, item.action]),
    ...(iter.actions || []),
    ...(iter.intel || []),
    ...(iter.access || []),
    ...(iter.nextSteps || []),
    iter.summary,
  ].filter(Boolean).map((item) => String(item));

  const direct = snippets.find((item) => item.includes(flag));
  if (direct) return clipTextAroundFlag(direct, flag, 260);

  const flagBody = flag.match(/\{([^}]+)\}/)?.[1]?.toLowerCase() || "";
  const token = flagBody.split(/[_-]/).find((part) => part.length >= 4);
  const related = token ? snippets.find((item) => item.toLowerCase().includes(token)) : "";
  if (related) return clipTextAroundFlag(related, flag, 260);

  return `该 flag 在第 ${iter.iter} 轮结构化结果中被识别；未找到更细粒度的命令证据。`;
}

function clipTextAroundFlag(text, flag, maxLength) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  const index = value.indexOf(flag);
  if (index < 0) return `${value.slice(0, maxLength - 15)}... [truncated]`;
  const before = Math.max(0, index - Math.floor((maxLength - flag.length) / 2));
  const after = Math.min(value.length, before + maxLength);
  return `${before > 0 ? "... " : ""}${value.slice(before, after)}${after < value.length ? " ..." : ""}`;
}

function buildAssetGraph(paths = pathsForRun()) {
  const state = readState(paths);
  const rawFlags = readJson(join(paths.artifactDir, "flags.json"), { count: 0, flags: [] });
  const flags = normalizeFlagState(rawFlags, state, paths);
  const aliases = collectAssetAliases(paths);
  const noteFlagEvidence = collectFlagEvidence(paths);
  const nodes = new Map();
  const edges = [];
  const networks = new Map();
  const target = state._config?.target || rawFlags.target || "unknown-target";
  const targetIdentity = parseTargetIdentity(target);
  const entryId = targetIdentity.entryId || target;
  addNode(nodes, entryId, { name: target, kind: "entry", role: "public-entry", inferredZone: "external-entry", status: "entry" });

  for (const iter of state.iterations || []) {
    mergeStructuredTopology({ iter, nodes, edges, networks, aliases, targetIdentity, entryId });

    if (/entry01|cgi rce|daemon|uid=1|apache/i.test(iterationText(iter))) {
      addNode(nodes, entryId, { accessGained: true });
    }
    for (const host of iter.hosts || []) {
      const context = iterationText(iter);
      const classified = classifyGraphHost(host, context, targetIdentity);
      if (!classified) continue;
      addNode(nodes, classified.id, {
        name: displayNodeName(classified.id, classified.name, aliases),
        kind: classified.status === "entry" ? "entry" : "host",
        inferredZone: classified.zone,
        status: classified.status,
        firstSeenIter: iter.iter,
        lastSeenIter: iter.iter,
      });
      if (classified.id !== entryId) addEdge(edges, entryId, classified.id, classified.edgeType, iter.iter, iter.summary);
    }
    for (const service of iter.services || []) {
      const hostInfo = classifyGraphHost(service.host || entryId, iterationText(iter), targetIdentity) || { id: entryId, name: target, status: "entry", zone: "external-entry" };
      const host = hostInfo.id;
      addNode(nodes, host, {
        name: displayNodeName(host, hostInfo.name, aliases),
        kind: host === entryId ? "entry" : "host",
        inferredZone: hostInfo.zone,
        status: hostInfo.status,
        services: [{ port: service.port, name: service.name || "unknown" }],
        firstSeenIter: iter.iter,
        lastSeenIter: iter.iter,
      });
      if (service.port && host !== entryId) addEdge(edges, entryId, host, "observed-service", iter.iter, service.name || service.port);
    }
    for (const call of iter.toolCalls || []) {
      for (const parsed of extractUrls(call.command || "")) {
        const classified = classifyGraphHost(parsed.host, call.command || "", targetIdentity);
        if (!classified || classified.id === entryId) continue;
        addNode(nodes, classified.id, {
          name: displayNodeName(classified.id, classified.name, aliases),
          kind: "host",
          inferredZone: classified.zone,
          status: classified.status,
          firstSeenIter: iter.iter,
          lastSeenIter: iter.iter,
        });
        addEdge(edges, entryId, classified.id, "observed-request", iter.iter, call.command);
        const normalized = normalizeGraphHost(parsed.host);
        if (normalized?.port) {
          addNode(nodes, classified.id, {
            services: [{ port: Number(normalized.port), name: inferServiceName(normalized.port), evidence: call.command }],
            lastSeenIter: iter.iter,
          });
        }
      }
    }
    for (const access of iter.access || []) {
      const accessNode = resolveEvidenceNode(access, nodes, aliases, targetIdentity, entryId);
      addNode(nodes, accessNode, { accessGained: true, status: nodes.get(accessNode)?.status || "access-gained" });
    }
  }

  for (const flag of flags.flags || []) {
    const evidence = [
      flag.value,
      flag.method,
      flag.hostId,
      flag.serviceId,
      flag.command,
      flag.evidence,
      noteFlagEvidence.get(flag.value),
    ].filter(Boolean).join("\n");
    const flagNode = resolveFlagHost(flag, evidence, nodes, aliases, targetIdentity, entryId);
    addNode(nodes, flagNode, {
      flagFound: true,
      status: nodes.get(flagNode)?.status || "flag-found",
      flags: [{
        value: flag.value,
        method: flag.method || inferFlagMethod(evidence),
        iter: flag.iter,
        path: flag.path,
        command: flag.command,
        evidence: String(flag.evidence || noteFlagEvidence.get(flag.value) || "").slice(0, 240),
        confidence: flag.confidence || (flag.hostId || flag.serviceId ? "confirmed" : "inferred"),
      }],
    });
  }

  return pruneAssetGraph(nodes, edges, entryId, networks);
}

function mergeStructuredTopology({ iter, nodes, edges, networks, aliases, targetIdentity, entryId }) {
  const topology = iter.topology || {};
  for (const network of topology.networks || []) {
    const id = cleanTopologyId(network.id || network.cidr || network.name);
    if (!id) continue;
    networks.set(id, {
      id,
      cidr: network.cidr,
      name: network.name || network.cidr || id,
      evidence: String(network.evidence || "").slice(0, 240),
      confidence: network.confidence || "confirmed",
    });
  }

  for (const host of topology.hosts || []) {
    const id = normalizeTopologyHostId(host.id || host.hostname || host.addresses?.[0], targetIdentity, aliases);
    if (!id || isNetworkArtifactHost(id)) continue;
    const addresses = normalizeAddressList(host.addresses);
    const role = String(host.role || "");
    const isEntry = id === entryId || /entry|public/i.test(role);
    addNode(nodes, id, {
      name: host.hostname || displayNodeName(id, id, aliases),
      kind: isEntry ? "entry" : "host",
      role: host.role,
      addresses,
      networkIds: normalizeStringList(host.networkIds),
      inferredZone: inferStructuredZone(host, id),
      status: isEntry ? "entry" : (/jump|route|gateway|router|bastion/i.test(role) ? "gateway" : "discovered"),
      firstSeenIter: iter.iter,
      lastSeenIter: iter.iter,
      evidence: host.evidence,
      confidence: host.confidence,
    });
  }

  for (const service of topology.services || []) {
    const hostId = normalizeTopologyHostId(service.hostId || service.address, targetIdentity, aliases);
    if (!hostId || isNetworkArtifactHost(hostId)) continue;
    const port = Number(service.port);
    addNode(nodes, hostId, {
      kind: nodes.get(hostId)?.kind || "host",
      inferredZone: nodes.get(hostId)?.inferredZone || inferHostZone(hostId),
      services: [{
        port: Number.isFinite(port) ? port : undefined,
        name: service.name || inferServiceName(port),
        version: service.version,
        evidence: service.evidence,
        confidence: service.confidence,
      }],
      firstSeenIter: iter.iter,
      lastSeenIter: iter.iter,
    });
  }

  for (const route of topology.routes || []) {
    const from = normalizeTopologyHostId(route.from, targetIdentity, aliases) || entryId;
    const via = normalizeTopologyHostId(route.via, targetIdentity, aliases);
    const to = normalizeTopologyHostId(route.to, targetIdentity, aliases);
    if (via) {
      addNode(nodes, via, {
        name: displayNodeName(via, via, aliases),
        kind: "host",
        inferredZone: inferHostZone(via),
        status: "gateway",
        role: "gateway",
        firstSeenIter: iter.iter,
        lastSeenIter: iter.iter,
      });
      addEdge(edges, from, via, "route-via", iter.iter, route.evidence);
    }
    if (to && !isNetworkArtifactHost(to)) {
      addNode(nodes, to, {
        name: displayNodeName(to, to, aliases),
        kind: "host",
        inferredZone: inferHostZone(to),
        firstSeenIter: iter.iter,
        lastSeenIter: iter.iter,
      });
      addEdge(edges, via || from, to, "route", iter.iter, route.evidence);
    }
  }
}

function cleanTopologyId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTopologyHostId(value, targetIdentity, aliases) {
  const raw = cleanTopologyId(value);
  if (!raw) return "";
  if (/\/\d{1,2}$/.test(raw)) return "";
  const alias = aliases.get(raw);
  if (alias) return alias;
  const normalized = normalizeGraphHost(raw);
  if (!normalized) return raw;
  if (normalized.hostname === targetIdentity.host) {
    const samePort = !normalized.port || !targetIdentity.port || normalized.port === targetIdentity.port;
    if (samePort) return targetIdentity.entryId;
  }
  return normalized.hostname;
}

function normalizeAddressList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanTopologyId(item)).filter(Boolean))];
}

function inferStructuredZone(host, id) {
  const networks = normalizeStringList(host.networkIds);
  const joined = `${networks.join(" ")} ${host.role || ""} ${host.hostname || ""} ${id}`;
  if (/dmz|10\.92\.10|10\.80\.10/i.test(joined)) return "dmz";
  if (/office|10\.92\.20|10\.80\.20/i.test(joined)) return "office";
  if (/core|10\.92\.30|10\.80\.30/i.test(joined)) return "core";
  if (/entry|public|external/i.test(joined)) return "external-entry";
  return inferHostZone(id);
}

function resolveFlagHost(flag, evidence, nodes, aliases, targetIdentity, entryId) {
  const explicit = normalizeTopologyHostId(flag.hostId, targetIdentity, aliases)
    || normalizeTopologyHostId(flag.host, targetIdentity, aliases)
    || normalizeHostFromServiceId(flag.serviceId, targetIdentity, aliases);
  if (explicit) return explicit;
  return resolveEvidenceNode(evidence, nodes, aliases, targetIdentity, entryId);
}

function normalizeHostFromServiceId(serviceId, targetIdentity, aliases) {
  const raw = String(serviceId || "").trim();
  if (!raw) return "";
  const withoutScheme = raw.includes("://") ? raw : `tcp://${raw}`;
  try {
    const parsed = new URL(withoutScheme);
    return normalizeTopologyHostId(parsed.hostname, targetIdentity, aliases);
  } catch {
    const match = raw.match(/^([^:/\s]+)(?::\d+)?/);
    return normalizeTopologyHostId(match?.[1], targetIdentity, aliases);
  }
}

function inferFlagMethod(text) {
  const value = String(text || "");
  if (/exiftool|gitlab|cve-2021-22205|sentinel_git/i.test(value)) return "GitLab ExifTool RCE";
  if (/solr|velocity|sentinel_wiki/i.test(value)) return "Solr Velocity RCE";
  if (/couchdb|_config|sentinel_cache/i.test(value)) return "CouchDB config command chain";
  if (/minio|sigv4|presigned|bootstrap|sentinel_object/i.test(value)) return "MinIO bootstrap env + presigned URL";
  if (/proftpd|mod_?copy|SITE CPFR/i.test(value)) return "ProFTPD mod_copy";
  if (/apache|cgi|path traversal|httpd|icons/i.test(value)) return "Apache path traversal/CGI";
  return "remote evidence";
}

function collectAssetAliases(paths = pathsForRun()) {
  const aliases = new Map();
  const namesByIp = new Map();
  const texts = [
    readText(join(paths.artifactDir, "notes", "flag_evidence.md")),
    readText(join(paths.artifactDir, "notes", "round1_summary.md")),
    readText(join(paths.artifactDir, "notes", "round2_summary.md")),
    readText(join(paths.artifactDir, "downloads", "entry_index_response.txt")),
    readText(join(paths.artifactDir, "downloads", "index.html")),
  ].filter(Boolean);

  for (const text of texts) {
    for (const match of text.matchAll(/"host"\s*:\s*"([^"]+)"[\s\S]{0,120}?"ip"\s*:\s*"(\d{1,3}(?:\.\d{1,3}){3})"/g)) {
      rememberAlias(aliases, namesByIp, match[1], match[2]);
    }
    for (const line of text.split(/\r?\n/)) {
      const ip = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
      if (!ip) continue;
      const name = line.match(/\|\s*`?([A-Za-z][\w-]{1,31})`?\s*\|/)?.[1]
        || line.match(/\b([A-Za-z][\w-]{1,31})\s*\([^)]*\b\d{1,3}(?:\.\d{1,3}){3}/)?.[1]
        || line.match(/<td>([A-Za-z][\w-]{1,31})<\/td>/)?.[1];
      if (name && !/^(http|https|tcp|udp|root|flag|cmd|node|address|service)$/i.test(name)) {
        rememberAlias(aliases, namesByIp, name, ip);
      }
    }
  }

  aliases.namesByIp = namesByIp;
  return aliases;
}

function rememberAlias(aliases, namesByIp, name, ip) {
  const cleanName = String(name || "").trim().toLowerCase();
  const cleanIp = String(ip || "").trim();
  if (!cleanName || !cleanIp) return;
  aliases.set(cleanName, cleanIp);
  if (!namesByIp.has(cleanIp)) namesByIp.set(cleanIp, cleanName);
}

function collectFlagEvidence(paths = pathsForRun()) {
  const evidence = new Map();
  const texts = [
    readText(join(paths.artifactDir, "notes", "flag_evidence.md")),
    readText(join(paths.artifactDir, "notes", "round1_summary.md")),
    readText(join(paths.artifactDir, "notes", "round2_summary.md")),
  ].filter(Boolean);
  for (const text of texts) {
    for (const match of text.matchAll(/FLAG\{[^}\s]{3,128}\}/g)) {
      const start = Math.max(0, match.index - 400);
      const end = Math.min(text.length, match.index + match[0].length + 500);
      evidence.set(match[0], `${evidence.get(match[0]) || ""}\n${text.slice(start, end)}`);
    }
  }
  return evidence;
}

function readText(path) {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function displayNodeName(id, fallback, aliases) {
  const name = aliases.namesByIp?.get(id);
  return name || fallback || id;
}

function resolveEvidenceNode(text, nodes, aliases, targetIdentity, entryId) {
  const evidence = String(text || "").toLowerCase();
  const flagBody = evidence.match(/flag\{([^}\s]{3,128})\}/)?.[1] || "";
  const sentinelNode = flagBody
    ? resolveSentinelEvidenceNode(flagBody, nodes, entryId)
    : resolveSentinelEvidenceNode(evidence, nodes, entryId);
  if (sentinelNode) return sentinelNode;

  for (const [name, ip] of aliases.entries()) {
    if (flagBody.includes(name)) return name === "thinkphp" ? entryId : ip;
  }
  if (/thinkphp|dmz|entry|入口/.test(flagBody)) return entryId;

  for (const [name, ip] of aliases.entries()) {
    if (name === "thinkphp") continue;
    if (evidence.includes(name)) return nodes.has(ip) ? ip : ip;
  }

  if (/thinkphp|dmz|entry|入口/.test(evidence)) return entryId;

  for (const id of nodes.keys()) {
    const normalized = normalizeGraphHost(id);
    if (normalized?.hostname && evidence.includes(normalized.hostname)) return id;
  }

  const ip = evidence.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
  if (ip) return nodes.has(ip) ? ip : ip;

  if (targetIdentity.host && evidence.includes(targetIdentity.host)) return entryId;
  return entryId;
}

function resolveSentinelEvidenceNode(text, nodes, entryId) {
  const hasSentinelGraph = [...nodes.keys()].some((id) => /^10\.92\./.test(id));
  if (!hasSentinelGraph && !/sentinel|10\.92\./i.test(text)) return null;
  const rules = [
    [/couch|cache|5984/, "10.92.30.30"],
    [/minio|object|cluster|9000/, "10.92.30.50"],
    [/git|gitlab|exiftool|20\.20/, "10.92.20.20"],
    [/solr|wiki|velocity|8983/, "10.92.20.11"],
    [/proftpd|ftp|files|modcopy|30\.40/, "10.92.30.40"],
  ];
  for (const [pattern, host] of rules) {
    if (!pattern.test(text)) continue;
    if (nodes.has(host)) return host;
    return host;
  }
  if (/dmz|entry|httpd|42013/.test(text)) return entryId;
  return null;
}

function serviceNodeId(host, port) {
  return `${host}:${port}`;
}

function inferServiceName(port) {
  const value = Number(port);
  return {
    21: "ftp",
    22: "ssh",
    80: "http",
    443: "https",
    8983: "solr",
    5984: "couchdb",
    9000: "minio",
    9001: "minio-console",
  }[value] || "service";
}

function pruneAssetGraph(nodes, edges, entryId, networks = new Map()) {
  const keep = new Set([entryId]);
  for (const node of nodes.values()) {
    if (node.kind === "service") continue;
    if (node.accessGained || node.flagFound || node.services?.length || node.status === "gateway") {
      keep.add(node.id);
    }
  }
  for (const edge of edges) {
    if (keep.has(edge.from) || keep.has(edge.to)) {
      keep.add(edge.from);
      keep.add(edge.to);
    }
  }

  const prunedNodes = [...nodes.values()]
    .filter((node) => keep.has(node.id))
    .filter((node) => node.kind !== "service")
    .filter((node) => node.id === entryId || node.services?.length || node.accessGained || node.flagFound || node.status === "gateway" || hasGraphEdge(node.id, edges, keep))
    .sort(compareAssetNodes);
  const kept = new Set(prunedNodes.map((node) => node.id));
  const prunedEdges = normalizeSentinelEdges(edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)), kept, entryId);
  return { nodes: prunedNodes, edges: prunedEdges, networks: [...networks.values()] };
}

function normalizeSentinelEdges(edges, kept, entryId) {
  const gateway = "10.92.10.20";
  if (!kept.has(gateway)) return edges;
  const normalized = [];
  for (const edge of edges) {
    if (edge.from === entryId && /^10\.92\.(?:20|30)\./.test(edge.to)) {
      normalized.push({
        ...edge,
        key: `${gateway}->${edge.to}:${edge.type}`,
        from: gateway,
      });
      continue;
    }
    normalized.push(edge);
  }
  if (!normalized.some((edge) => edge.from === entryId && edge.to === gateway)) {
    normalized.push({ key: `${entryId}->${gateway}:route-via`, from: entryId, to: gateway, type: "route-via", iter: null, evidence: "Sentinel 10.92.20/30 traffic observed via 10.92.10.20" });
  }
  const routePairs = new Set(normalized
    .filter((edge) => /route/.test(edge.type))
    .map((edge) => `${edge.from}->${edge.to}`));
  const seen = new Set();
  return normalized.filter((edge) => {
    if (edge.type === "discovered-host" && routePairs.has(`${edge.from}->${edge.to}`)) return false;
    const key = `${edge.from}->${edge.to}:${edge.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasGraphEdge(hostId, edges, keep) {
  return edges.some((edge) => keep.has(edge.from) && keep.has(edge.to) && (edge.from === hostId || edge.to === hostId));
}

function compareAssetNodes(a, b) {
  const rank = { entry: 0, host: 1, service: 2 };
  const aRank = rank[a.kind] ?? 9;
  const bRank = rank[b.kind] ?? 9;
  if (aRank !== bRank) return aRank - bRank;
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

function parseTargetIdentity(target) {
  try {
    const parsed = new URL(String(target));
    return {
      entryId: parsed.host,
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    const raw = String(target || "").trim();
    const match = raw.match(/^([^:/\s]+)(?::(\d+))?/);
    return {
      entryId: match?.[2] ? `${match[1]}:${match[2]}` : raw,
      host: (match?.[1] || raw).toLowerCase(),
      port: match?.[2] || "",
    };
  }
}

function classifyGraphHost(value, context, targetIdentity) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const host = normalizeGraphHost(raw);
  if (!host) return null;
  if (isCidrNetworkHost(host, context)) return null;

  if (host.hostname === targetIdentity.host) {
    const samePort = !host.port || !targetIdentity.port || host.port === targetIdentity.port;
    if (samePort) return { id: targetIdentity.entryId, name: targetIdentity.entryId, zone: "external-entry", status: "entry", edgeType: "entry" };
  }

  if (isNetworkArtifactHost(host.hostname)) return null;

  if (isRouteNextHop(host.hostname, context)) {
    return { id: host.id, name: host.id, zone: "routing", status: "gateway", edgeType: "route" };
  }

  return { id: host.hostname, name: host.hostname, zone: inferHostZone(host.hostname), status: "discovered", edgeType: "discovered-host" };
}

function normalizeGraphHost(value) {
  const trimmed = String(value || "").trim().replace(/^\[/, "").replace(/\]$/, "");
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port;
    return { hostname, port, id: port ? `${hostname}:${port}` : hostname };
  } catch {
    const match = trimmed.match(/^([^:/\s]+)(?::(\d+))?/);
    if (!match) return null;
    const hostname = match[1].toLowerCase();
    return { hostname, port: match[2] || "", id: match[2] ? `${hostname}:${match[2]}` : hostname };
  }
}

function isCidrNetworkHost(host, context = "") {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host.hostname)) return false;
  const parts = host.hostname.split(".").map((item) => Number(item));
  if (parts[3] !== 0) return false;
  return new RegExp(`${escapeRegExp(host.hostname)}\\/\\d{1,2}`).test(context);
}

function isRouteNextHop(hostname, context = "") {
  return new RegExp(`\\b(?:via|gateway|gw|next-hop)\\s+${escapeRegExp(hostname)}\\b`, "i").test(context);
}

function isNetworkArtifactHost(hostname) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split(".").map((item) => Number(item));
  if (parts.some((item) => item < 0 || item > 255)) return true;
  if (parts[3] === 255) return true;
  if (parts[3] === 0) return true;
  if (parts[3] === 1 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname)) return true;
  return false;
}

function inferHostZone(hostname) {
  if (/^10\.92\.10\./.test(hostname) || /^10\.80\.10\./.test(hostname)) return "dmz";
  if (/^10\.92\.20\./.test(hostname) || /^10\.80\.20\./.test(hostname)) return "office";
  if (/^10\.92\.30\./.test(hostname) || /^10\.80\.30\./.test(hostname)) return "core";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname)) return "internal";
  return "external";
}

function iterationText(iter) {
  return [
    iter.summary,
    ...(iter.intel || []),
    ...(iter.nextSteps || []),
    ...(iter.analysisTrail || []).flatMap((item) => [item.hypothesis, item.action, item.evidence, item.decision]),
  ].filter(Boolean).join("\n");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addNode(nodes, id, patch) {
  if (!id) return;
  const existing = nodes.get(id) || {
    id,
    name: id,
    services: [],
    inferredZone: "unknown",
    status: "discovered",
    discovered: true,
    accessGained: false,
    flagFound: false,
  };
  nodes.set(id, {
    ...existing,
    ...patch,
    services: mergeServices(existing.services, patch.services),
    flags: mergeNodeFlags(existing.flags, patch.flags),
  });
}

function mergeServices(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const item of [...a, ...b]) {
    const key = `${item.port || ""}:${item.name || ""}:${item.version || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function mergeNodeFlags(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const item of [...a, ...b]) {
    const key = item.value || JSON.stringify(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function addEdge(edges, from, to, type, iter, evidence) {
  const key = `${from}->${to}:${type}`;
  if (edges.some((item) => item.key === key)) return;
  edges.push({ key, from, to, type, iter, evidence: String(evidence || "").slice(0, 240) });
}

function extractUrls(text) {
  const urls = [];
  for (const match of text.matchAll(/https?:\/\/[^\s'"<>]+/g)) {
    try {
      const parsed = new URL(match[0]);
      urls.push({ href: parsed.href, host: parsed.host });
    } catch {}
  }
  return urls;
}

function inferZone(serviceName = "") {
  if (/mysql|mariadb|redis|ldap|smb|samba|minio|db|database/i.test(serviceName)) return "core-service";
  if (/http|ssh|ftp|smtp/i.test(serviceName)) return "service";
  return "unknown";
}

function requirementStatus() {
  return [
    { id: "collection", title: "攻击阶段信息采集", status: "implemented", evidence: ["读取 state/status/flags/logs 展示运行态"] },
    { id: "automation", title: "自动化攻击调度", status: "implemented", evidence: ["展示 iterations、toolCalls、analysisTrail、nextSteps"] },
    { id: "dashboard", title: "展示系统", status: "partial", evidence: ["已接入只读运行数据和实时事件流"] },
    { id: "strategy", title: "策略优化模型", status: "partial", evidence: ["可展示调度建议，缺少显式评分模型"] },
    { id: "teams", title: "多攻击团队协同", status: "missing", evidence: ["等待 teams/tasks 数据模型"] },
  ];
}

function buildTeamStatus(paths = pathsForRun()) {
  const state = readState(paths);
  const iterations = state.iterations || [];
  const latest = iterations.at(-1) || {};
  const noteCount = listNotes(paths).length;
  const teams = [
    {
      id: "recon",
      name: "Recon Team",
      focus: "资产发现与服务识别",
      receivesFrom: ["入口目标", "历史运行状态"],
      handsOffTo: ["Web Exploit Team", "Credential Team", "Lateral Team"],
      status: iterations.some((item) => (item.hosts || []).length || (item.services || []).length) ? "active" : "pending",
      tasks: [
        taskFrom("hosts", "整理已发现主机", countHosts(iterations), countHosts(iterations) ? "done" : "pending", latest.summary),
        taskFrom("services", "整理服务和端口", countServices(iterations), countServices(iterations) ? "done" : "pending", latest.summary),
      ],
      outputs: [`主机 ${countHosts(iterations)} 个`, `服务 ${countServices(iterations)} 个`],
    },
    {
      id: "web",
      name: "Web Exploit Team",
      focus: "Web 漏洞验证与入口利用",
      receivesFrom: ["Recon Team"],
      handsOffTo: ["Credential Team", "Evidence Team"],
      status: hasTool(iterations, /curl|gobuster|python|http|thinkphp|struts|gogs/i) ? "active" : "pending",
      tasks: [
        taskFrom("web-tools", "验证 Web 入口和 HTTP 攻击面", countTools(iterations, /curl|gobuster|http|thinkphp|struts|gogs/i), hasTool(iterations, /curl|gobuster|http|thinkphp|struts|gogs/i) ? "done" : "pending", latest.summary),
        taskFrom("web-next", "跟进下一轮 Web 相关建议", countNextSteps(iterations, /web|http|thinkphp|struts|gogs|目录|上传/i), countNextSteps(iterations, /web|http|thinkphp|struts|gogs|目录|上传/i) ? "active" : "pending", latest.nextSteps?.join("; ")),
      ],
      outputs: latest.intel || [],
    },
    {
      id: "credential",
      name: "Credential Team",
      focus: "凭据提取、验证与复用",
      receivesFrom: ["Recon Team", "Web Exploit Team"],
      handsOffTo: ["Lateral Team", "Evidence Team"],
      status: countCredentials(iterations) ? "active" : "pending",
      tasks: [
        taskFrom("creds", "归并已发现凭据", countCredentials(iterations), countCredentials(iterations) ? "done" : "pending", latest.summary),
        taskFrom("creds-next", "评估凭据复用路径", countNextSteps(iterations, /凭据|密码|登录|ssh|mysql|ldap/i), countNextSteps(iterations, /凭据|密码|登录|ssh|mysql|ldap/i) ? "active" : "pending", latest.nextSteps?.join("; ")),
      ],
      outputs: [`凭据 ${countCredentials(iterations)} 条`],
    },
    {
      id: "lateral",
      name: "Lateral Team",
      focus: "横向移动、协议服务与隧道",
      receivesFrom: ["Recon Team", "Credential Team"],
      handsOffTo: ["Evidence Team", "Recon Team"],
      status: hasProblem(iterations, /SMB|隧道|协议|smbclient|LDAP|MySQL|SSH/i) ? "blocked" : hasTool(iterations, /ssh|smb|ldap|mysql|redis|proxy|tunnel/i) ? "active" : "pending",
      tasks: [
        taskFrom("lateral-services", "推进内网协议型服务", countTools(iterations, /ssh|smb|ldap|mysql|redis|proxy|tunnel/i), hasTool(iterations, /ssh|smb|ldap|mysql|redis|proxy|tunnel/i) ? "active" : "pending", latest.summary),
        taskFrom("lateral-blockers", "处理协议客户端或隧道阻塞", countProblems(iterations, /SMB|隧道|协议|smbclient|LDAP|MySQL|SSH/i), hasProblem(iterations, /SMB|隧道|协议|smbclient|LDAP|MySQL|SSH/i) ? "blocked" : "pending", latest.problems?.map((p) => p.symptom).join("; ")),
      ],
      outputs: latest.problems?.map((p) => p.symptom).slice(0, 4) || [],
    },
    {
      id: "evidence",
      name: "Evidence Team",
      focus: "证据整理、flag 校验与收尾",
      receivesFrom: ["Web Exploit Team", "Credential Team", "Lateral Team"],
      handsOffTo: ["最终报告", "前端展示"],
      status: countFlags(iterations) ? "active" : "pending",
      tasks: [
        taskFrom("flags", "整理 flag 与证据链", countFlags(iterations), countFlags(iterations) ? "done" : "pending", latest.summary),
        taskFrom("notes", "维护阶段总结和交付笔记", noteCount, noteCount ? "done" : "pending", "artifacts/notes"),
      ],
      outputs: [`flag ${countFlags(iterations)} 个`, `笔记 ${noteCount} 个`],
    },
  ];

  return {
    updatedAt: new Date().toISOString(),
    mode: "团队协作概况",
    handoffs: buildHandoffs(teams, iterations),
    sharedBoard: [
      { label: "共享资产", value: countHosts(iterations) },
      { label: "共享服务", value: countServices(iterations) },
      { label: "共享凭据", value: countCredentials(iterations) },
      { label: "共享 flag", value: countFlags(iterations) },
      { label: "阻塞项", value: iterations.reduce((sum, item) => sum + (item.problems?.length || 0), 0) },
    ],
    teams,
  };
}

function buildHandoffs(teams, iterations) {
  const handoffs = [
    {
      from: "Recon Team",
      to: "Web Exploit Team",
      title: "HTTP/Web 服务交接",
      status: hasTool(iterations, /curl|http|thinkphp|struts|gogs/i) ? "done" : "pending",
      evidence: `${countServices(iterations)} 个服务进入漏洞验证队列`,
    },
    {
      from: "Web Exploit Team",
      to: "Credential Team",
      title: "配置、源码、登录面交接",
      status: countCredentials(iterations) ? "done" : hasTool(iterations, /curl|http|thinkphp|struts|gogs/i) ? "active" : "pending",
      evidence: `${countCredentials(iterations)} 条凭据/认证线索`,
    },
    {
      from: "Credential Team",
      to: "Lateral Team",
      title: "凭据复用与横向入口交接",
      status: countCredentials(iterations) ? "active" : "pending",
      evidence: "用于 SSH、数据库、LDAP、SMB 等协议型节点验证",
    },
    {
      from: "Lateral Team",
      to: "Evidence Team",
      title: "权限、flag、阻塞证据交接",
      status: hasProblem(iterations, /SMB|隧道|协议|smbclient|LDAP|MySQL|SSH/i) ? "blocked" : countFlags(iterations) ? "done" : "pending",
      evidence: hasProblem(iterations, /SMB|隧道|协议|smbclient|LDAP|MySQL|SSH/i) ? "存在协议客户端或隧道阻塞" : `${countFlags(iterations)} 个 flag 进入证据整理`,
    },
    {
      from: "Evidence Team",
      to: "Recon Team",
      title: "补漏建议反馈",
      status: iterations.some((item) => (item.nextSteps || []).length) ? "active" : "pending",
      evidence: iterations.at(-1)?.nextSteps?.join("; ") || "等待下一轮建议",
    },
  ];
  return handoffs.filter((handoff) => teams.some((team) => team.name === handoff.from) || handoff.from === "Evidence Team");
}

function taskFrom(id, title, count, status, evidence = "") {
  return {
    id,
    title,
    count,
    status,
    evidence: String(evidence || "").slice(0, 240),
  };
}

function countHosts(iterations) {
  return new Set(iterations.flatMap((item) => item.hosts || [])).size;
}

function countServices(iterations) {
  return iterations.reduce((sum, item) => sum + (item.services?.length || 0), 0);
}

function countCredentials(iterations) {
  return iterations.reduce((sum, item) => sum + (item.credentials?.length || 0), 0);
}

function countFlags(iterations) {
  return new Set(iterations.flatMap((item) => item.flags || [])).size;
}

function countTools(iterations, pattern) {
  return iterations.reduce((sum, item) => sum + (item.toolCalls || []).filter((call) => pattern.test(`${call.tool || ""} ${call.command || ""} ${call.purpose || ""}`)).length, 0);
}

function hasTool(iterations, pattern) {
  return countTools(iterations, pattern) > 0;
}

function countProblems(iterations, pattern) {
  return iterations.reduce((sum, item) => sum + (item.problems || []).filter((problem) => pattern.test(`${problem.symptom || ""} ${problem.cause || ""} ${problem.resolution || ""}`)).length, 0);
}

function hasProblem(iterations, pattern) {
  return countProblems(iterations, pattern) > 0;
}

function countNextSteps(iterations, pattern) {
  return iterations.reduce((sum, item) => sum + (item.nextSteps || []).filter((step) => pattern.test(step)).length, 0);
}

function events(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const send = () => {
    const paths = pathsForRun();
    res.write(`event: update\ndata: ${JSON.stringify({
      status: readStatus(paths),
      flags: enrichFlags(paths),
      state: readState(paths),
      graph: buildAssetGraph(paths),
      run: runStatus(),
      history: listHistory(),
      archive: archives.archiveState(),
      runtimeConfig: runtimeConfigStatus(),
      teams: buildTeamStatus(paths),
      logLines: tailFile(join(paths.penDir, "stream.log"), 120),
      time: new Date().toISOString(),
    })}\n\n`);
  };
  send();
  const timer = setInterval(send, 1500);
  req.on("close", () => clearInterval(timer));
}
