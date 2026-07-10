import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson } from "./fs-utils.js";

export function createArchiveStore({ rootDir, archiveDir, livePenDir, liveArtifactDir }) {
  let selectedArchiveId = "live";
  let penDir = livePenDir;
  let artifactDir = liveArtifactDir;

  /**
   * Return currently selected data directories for all dashboard readers.
   */
  function currentDirs() {
    return { penDir, artifactDir, selectedArchiveId };
  }

  /**
   * Return all selectable archive snapshots plus the live data source.
   */
  function archiveState() {
    const items = listArchives();
    if (selectedArchiveId !== "live" && !items.some((item) => item.id === selectedArchiveId)) {
      setDataRoot("live", rootDir);
    }
    return {
      selected: selectedArchiveId,
      selectedLabel: items.find((item) => item.id === selectedArchiveId)?.label || "实时数据",
      items,
    };
  }

  /**
   * Switch the active data source to live or a named archive snapshot.
   */
  function selectArchive(id = "live") {
    const snapshotId = String(id || "live").trim() || "live";
    if (snapshotId === "live") {
      setDataRoot("live", rootDir);
      return archiveState();
    }
    const target = resolveArchiveRoot(snapshotId);
    if (!target) return null;
    setDataRoot(snapshotId, target);
    return archiveState();
  }

  function selectLive() {
    return selectArchive("live");
  }

  /**
   * Discover valid snapshots under the archive root.
   */
  function listArchives() {
    const items = [{
      id: "live",
      label: "实时数据",
      description: "读取当前运行目录",
      updatedAt: null,
      flagCount: null,
    }];
    const seen = new Set();
    for (const snapshot of discoverArchiveSnapshots(archiveDir)) {
      if (seen.has(snapshot.id)) continue;
      seen.add(snapshot.id);
      items.push(snapshot);
    }
    return items;
  }

  function discoverArchiveSnapshots(baseDir) {
    if (!existsSync(baseDir)) return [];
    const snapshots = [];
    const base = resolve(baseDir);
    const visit = (dir, rel, depth) => {
      if (depth > 3) return;
      if (isArchiveSnapshot(dir)) {
        snapshots.push(readArchiveMeta(dir, rel || "__root__"));
        if (rel) return;
      }
      for (const name of readdirSync(dir)) {
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

  function isArchiveSnapshot(dir) {
    return existsSync(join(dir, ".pen-agent", "state.json")) || existsSync(join(dir, "artifacts", "flags.json"));
  }

  function readArchiveMeta(dir, id) {
    const meta = readJson(join(dir, "archive.json"), {});
    const state = readJson(join(dir, ".pen-agent", "state.json"), { iteration: 0, iterations: [] });
    const flags = readJson(join(dir, "artifacts", "flags.json"), { count: 0, updatedAt: null });
    const updatedAt = meta.updatedAt || flags.updatedAt || state.iterations?.at?.(-1)?.time || null;
    return {
      id,
      label: meta.label || prettifyArchiveId(id),
      description: meta.description || "",
      updatedAt,
      flagCount: Number.isFinite(Number(flags.count)) ? Number(flags.count) : (state.iterations || []).flatMap((item) => item.flags || []).length,
      iterations: state.iteration || state.iterations?.length || 0,
    };
  }

  function prettifyArchiveId(id) {
    if (id === "__root__") return "原始归档";
    return id.split("/").at(-1).replace(/^demo-\d+-/i, "").replace(/[-_]+/g, " ");
  }

  function resolveArchiveRoot(id) {
    if (id === "__root__" && isArchiveSnapshot(archiveDir)) return archiveDir;
    if (!/^[A-Za-z0-9_.\-/]+$/.test(id)) return null;
    const archiveRoot = resolve(archiveDir);
    const target = resolve(archiveRoot, id);
    if (!target.startsWith(`${archiveRoot}/`) || !isArchiveSnapshot(target)) return null;
    return target;
  }

  function setDataRoot(id, dataRoot) {
    selectedArchiveId = id;
    penDir = join(dataRoot, ".pen-agent");
    artifactDir = join(dataRoot, "artifacts");
  }

  return {
    archiveState,
    currentDirs,
    selectArchive,
    selectLive,
  };
}
