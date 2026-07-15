<script setup lang="ts">
import { computed } from "vue";
import { useRuntimeStore } from "../stores/runtime";
import type { AssetNode } from "../types";

const store = useRuntimeStore();

const laneOrder = ["entry", "dmz", "office", "core", "services", "external", "unknown"] as const;
const laneLabels: Record<string, string> = {
  entry: "入口",
  dmz: "DMZ",
  office: "Office",
  core: "Core",
  services: "服务",
  external: "外部",
  unknown: "未知",
};
const laneHints: Record<string, string> = {
  entry: "公网入口与已确认跳板",
  dmz: "入口容器所在区段",
  office: "业务应用与办公服务",
  core: "核心服务与数据面",
  services: "独立服务节点",
  external: "本机、域名或公网别名",
  unknown: "尚未归类的发现",
};

const nodeWidth = 154;
const nodeHeight = 72;
const laneWidth = 184;
const laneGap = 24;
const topOffset = 104;
const rowGap = 18;

const graphNodes = computed(() => store.assets.slice(0, 72));
const graphEdges = computed(() => store.edges.slice(0, 140));
const serviceCount = computed(() => graphNodes.value.reduce((sum, node) => sum + (node.services?.length || 0), 0));
const highlightedCount = computed(() => graphNodes.value.filter((node) => node.accessGained || node.flagFound).length);

const laneGroups = computed(() => {
  const grouped = new Map<string, AssetNode[]>();
  for (const lane of laneOrder) grouped.set(lane, []);
  for (const node of graphNodes.value) {
    grouped.get(resolveLane(node))?.push(node);
  }
  return laneOrder
    .map((key) => ({
      key,
      label: laneLabels[key],
      hint: laneHints[key],
      nodes: sortLaneNodes(grouped.get(key) || []),
    }))
    .filter((lane) => lane.nodes.length || lane.key === "entry" || lane.key === "core")
    .map((lane, index) => ({
      ...lane,
      x: 32 + index * (laneWidth + laneGap),
    }));
});

const svgWidth = computed(() => laneGroups.value.length * laneWidth + Math.max(0, laneGroups.value.length - 1) * laneGap + 64);

const topologyNodes = computed(() => {
  return laneGroups.value.flatMap((lane) => lane.nodes.map((node, index) => {
    const x = lane.x + (laneWidth - nodeWidth) / 2;
    const y = topOffset + index * (nodeHeight + rowGap);
    return {
      ...node,
      laneKey: lane.key,
      laneLabel: lane.label,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
      className: nodeClassName(node),
      zoneLabel: node.inferredZone || node.status || "node",
      serviceText: serviceSummary(node),
      shortName: trimMiddle(node.name || node.id, 18),
    };
  }));
});

const topologyHeight = computed(() => {
  const maxRows = Math.max(2, ...laneGroups.value.map((lane) => lane.nodes.length));
  return topOffset + maxRows * (nodeHeight + rowGap) + 34;
});

const topologyNodeMap = computed(() => new Map(topologyNodes.value.map((node) => [node.id, node])));

const topologyEdges = computed(() => {
  const seen = new Set<string>();
  return graphEdges.value
    .map((edge) => {
      const fromNode = topologyNodeMap.value.get(edge.from);
      const toNode = topologyNodeMap.value.get(edge.to);
      if (!fromNode || !toNode || fromNode.id === toNode.id) return null;
      const key = `${fromNode.id}->${toNode.id}:${edge.type}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const fromX = fromNode.x + fromNode.width;
      const fromY = fromNode.y + fromNode.height / 2;
      const toX = toNode.x;
      const toY = toNode.y + toNode.height / 2;
      const curve = Math.max(42, Math.abs(toX - fromX) * 0.42);
      return {
        ...edge,
        key,
        fromNode,
        toNode,
        className: edgeClassName(edge.type),
        path: `M ${fromX} ${fromY} C ${fromX + curve} ${fromY}, ${toX - curve} ${toY}, ${toX} ${toY}`,
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
    .slice(0, 90);
});

const primaryAssets = computed(() => {
  return graphNodes.value
    .filter((node) => node.status !== "service")
    .sort((a, b) => Number(Boolean(b.flagFound)) - Number(Boolean(a.flagFound))
      || Number(Boolean(b.accessGained)) - Number(Boolean(a.accessGained))
      || (b.services?.length || 0) - (a.services?.length || 0)
      || String(a.name).localeCompare(String(b.name)))
    .slice(0, 12);
});

function resolveLane(node: AssetNode) {
  const zone = String(node.inferredZone || "").toLowerCase();
  const status = String(node.status || "").toLowerCase();
  if (zone === "external-entry" || status === "entry") return "entry";
  if (status === "service") return "services";
  if (zone.includes("dmz")) return "dmz";
  if (zone.includes("office")) return "office";
  if (zone.includes("core")) return "core";
  if (zone.includes("external")) return "external";
  return "unknown";
}

function sortLaneNodes(nodes: AssetNode[]) {
  return [...nodes].sort((a, b) => Number(Boolean(b.flagFound)) - Number(Boolean(a.flagFound))
    || Number(Boolean(b.accessGained)) - Number(Boolean(a.accessGained))
    || Number(Boolean(b.services?.length)) - Number(Boolean(a.services?.length))
    || String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true }));
}

function nodeClassName(node: AssetNode) {
  if (node.flagFound) return "flag";
  if (node.accessGained) return "access";
  if (node.status === "entry" || node.inferredZone === "external-entry") return "entry";
  if (node.status === "service") return "service";
  return "host";
}

function edgeClassName(type?: string) {
  const value = String(type || "");
  if (value.includes("route")) return "route";
  if (value.includes("request")) return "request";
  if (value.includes("service")) return "service";
  return "discover";
}

function serviceSummary(node: AssetNode) {
  const services = node.services || [];
  if (!services.length) return "no exposed service";
  const unique = [...new Map(services.map((service) => [
    `${service.port || "-"}:${service.name || "service"}`,
    `${service.name || "svc"}:${service.port || "-"}`,
  ])).values()];
  const shown = unique.slice(0, 2).join(" · ");
  return unique.length > 2 ? `${shown} +${unique.length - 2}` : shown;
}

function trimMiddle(text: string, maxLength: number) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  const head = Math.ceil((maxLength - 3) * 0.58);
  const tail = Math.floor((maxLength - 3) * 0.42);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}
</script>

<template>
  <section class="topology-workspace">
    <div class="topology-summary">
      <article>
        <span>资产</span>
        <strong>{{ graphNodes.length }}</strong>
      </article>
      <article>
        <span>服务</span>
        <strong>{{ serviceCount }}</strong>
      </article>
      <article>
        <span>链路</span>
        <strong>{{ topologyEdges.length }}</strong>
      </article>
      <article>
        <span>关键节点</span>
        <strong>{{ highlightedCount }}</strong>
      </article>
    </div>

    <div class="topology-map-card">
      <div class="topology-map-head">
        <div>
          <span>Attack Surface Map</span>
          <h2>网络分区拓扑</h2>
        </div>
        <div class="topology-legend">
          <span><i class="entry"></i>入口</span>
          <span><i class="host"></i>主机</span>
          <span><i class="service"></i>服务</span>
          <span><i class="access"></i>已获权限</span>
          <span><i class="flag"></i>已获 flag</span>
        </div>
      </div>

      <div class="topology-canvas">
        <svg :viewBox="`0 0 ${svgWidth} ${topologyHeight}`" role="img" aria-label="按网络分区展示的资产拓扑图">
          <defs>
            <marker id="topologyArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z"></path>
            </marker>
          </defs>

          <g class="topology-lanes">
            <g v-for="lane in laneGroups" :key="lane.key" class="topology-lane" :class="lane.key">
              <rect :x="lane.x" y="20" :width="laneWidth" :height="topologyHeight - 38" rx="18"></rect>
              <text :x="lane.x + 16" y="48" class="lane-title">{{ lane.label }}</text>
              <text :x="lane.x + 16" y="68" class="lane-hint">{{ lane.hint }}</text>
              <text :x="lane.x + laneWidth - 18" y="48" class="lane-count">{{ lane.nodes.length }}</text>
            </g>
          </g>

          <g class="topology-edges">
            <path
              v-for="edge in topologyEdges"
              :key="edge.key"
              class="topology-edge"
              :class="edge.className"
              :d="edge.path"
            >
              <title>{{ edge.from }} -> {{ edge.to }} · {{ edge.type }}</title>
            </path>
          </g>

          <g class="topology-nodes">
            <g
              v-for="node in topologyNodes"
              :key="node.id"
              class="topology-node-card"
              :class="node.className"
              :transform="`translate(${node.x}, ${node.y})`"
            >
              <title>{{ node.name }} · {{ node.zoneLabel }} · {{ node.serviceText }}</title>
              <rect :width="node.width" :height="node.height" rx="13"></rect>
              <circle cx="18" cy="20" r="8"></circle>
              <text x="34" y="24" class="node-name">{{ node.shortName }}</text>
              <text x="14" y="45" class="node-zone">{{ node.zoneLabel }}</text>
              <text x="14" y="61" class="node-services">{{ node.serviceText }}</text>
            </g>
          </g>
        </svg>
      </div>
    </div>

    <div class="asset-grid compact topology-assets">
      <article v-for="node in primaryAssets" :key="node.id" class="asset-card" :class="{ important: node.flagFound || node.accessGained }">
        <strong>{{ node.name }}</strong>
        <span>{{ node.inferredZone || "unknown" }} · {{ node.status || "discovered" }}</span>
        <small>{{ serviceSummary(node) }} · first {{ node.firstSeenIter || "-" }} / last {{ node.lastSeenIter || "-" }}</small>
      </article>
    </div>
  </section>
</template>
