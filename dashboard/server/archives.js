import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson } from "./fs-utils.js";
import { isPathInside, isSafeHistoryRunId } from "./path-utils.js";

const defaultArchiveId = "legacy/history/demo-03-full-chain";

export function createArchiveStore({ historyDir, legacyArchiveDir, livePenDir, liveArtifactDir, listHistory }) {
  let selectedDataSourceId = defaultArchiveId;

  function archiveState() {
    const items = listArchiveItems();
    if (!items.some((item) => item.id === selectedDataSourceId)) selectedDataSourceId = "live";
    return {
      selected: selectedDataSourceId,
      selectedLabel: items.find((item) => item.id === selectedDataSourceId)?.label || "实时数据",
      items,
    };
  }

  function selectArchive(id) {
    const snapshotId = String(id || "live").trim() || "live";
    if (!listArchiveItems().some((item) => item.id === snapshotId)) return null;
    selectedDataSourceId = snapshotId;
    return archiveState();
  }

  function resetToLive() {
    selectedDataSourceId = "live";
  }

  function pathsForRun(runId) {
    const id = String(runId || selectedDataSourceId || "").trim();
    if (id.startsWith("history/")) return pathsForRun(id.replace(/^history\//, ""));
    if (id.startsWith("legacy/")) return legacyPathsForRun(id.replace(/^legacy\//, ""), id);
    if (id === "__root__") return legacyPathsForRun(id, id);
    if (!id || id === "live" || id === "current") return { penDir: livePenDir, artifactDir: liveArtifactDir, readonly: false, runId: "" };
    if (!isSafeHistoryRunId(id)) throw new Error("invalid run id");
    const base = resolve(historyDir, id);
    if (!isPathInside(historyDir, base)) throw new Error("invalid run id");
    return {
      penDir: join(base, ".pen-agent"),
      artifactDir: join(base, "artifacts"),
      readonly: true,
      runId: id,
    };
  }

  function legacyPathsForRun(legacyId, runId) {
    const legacyRoot = resolveLegacyArchiveRoot(legacyId);
    if (!legacyRoot) throw new Error("invalid legacy archive id");
    return {
      penDir: join(legacyRoot, ".pen-agent"),
      artifactDir: join(legacyRoot, "artifacts"),
      readonly: true,
      runId,
    };
  }

  function listArchiveItems() {
    return [
      {
        id: "live",
        label: "实时数据",
        description: "读取当前运行目录",
        updatedAt: null,
        flagCount: null,
      },
      ...listHistory().map((run) => ({
        id: `history/${run.id}`,
        label: run.target ? `${run.target} · ${run.status || "history"}` : `历史运行 ${run.id}`,
        description: run.command || "",
        updatedAt: run.endedAt || run.startedAt || null,
        flagCount: run.flagsFound ?? null,
        iterations: run.iterations ?? null,
      })),
      ...discoverLegacyArchiveSnapshots(legacyArchiveDir),
    ];
  }

  function discoverLegacyArchiveSnapshots(baseDir) {
    if (!existsSync(baseDir)) return [];
    const snapshots = [];
    const base = resolve(baseDir);
    const seen = new Set();
    const visit = (dir, rel, depth) => {
      if (depth > 3) return;
      if (isArchiveSnapshot(dir)) {
        const item = readLegacyArchiveMeta(dir, rel || "__root__");
        if (!seen.has(item.id)) {
          seen.add(item.id);
          snapshots.push(item);
        }
        if (rel) return;
      }
      for (const name of safeReadDir(dir)) {
        if (name.startsWith(".")) continue;
        const child = join(dir, name);
        try {
          if (statSync(child).isDirectory()) visit(child, rel ? `${rel}/${name}` : name, depth + 1);
        } catch {}
      }
    };
    visit(base, "", 0);
    return snapshots.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function safeReadDir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  function isArchiveSnapshot(dir) {
    return existsSync(join(dir, ".pen-agent", "state.json")) || existsSync(join(dir, "artifacts", "flags.json"));
  }

  function readLegacyArchiveMeta(dir, id) {
    const meta = readJson(join(dir, "archive.json"), {});
    const state = readJson(join(dir, ".pen-agent", "state.json"), { iteration: 0, iterations: [] });
    const flags = readJson(join(dir, "artifacts", "flags.json"), { count: 0, updatedAt: null });
    const updatedAt = meta.updatedAt || flags.updatedAt || state.iterations?.at?.(-1)?.time || null;
    return {
      id: id === "__root__" ? "__root__" : `legacy/${id}`,
      label: meta.label || prettifyArchiveId(id),
      description: meta.description || "历史演示快照",
      updatedAt,
      flagCount: Number.isFinite(Number(flags.count)) ? Number(flags.count) : (state.iterations || []).flatMap((item) => item.flags || []).length,
      iterations: state.iteration || state.iterations?.length || 0,
    };
  }

  function prettifyArchiveId(id) {
    if (id === "__root__") return "原始归档";
    return id.split("/").at(-1).replace(/^demo-\d+-/i, "").replace(/[-_]+/g, " ");
  }

  function resolveLegacyArchiveRoot(id) {
    if (id === "__root__" && isArchiveSnapshot(legacyArchiveDir)) return legacyArchiveDir;
    if (!/^[A-Za-z0-9_.\-/]+$/.test(id)) return null;
    const archiveRoot = resolve(legacyArchiveDir);
    const target = resolve(archiveRoot, id);
    if (!isPathInside(archiveRoot, target) || !isArchiveSnapshot(target)) return null;
    return target;
  }

  return {
    archiveState,
    pathsForRun,
    resetToLive,
    selectArchive,
  };
}
