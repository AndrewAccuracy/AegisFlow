<script setup lang="ts">
import { computed } from "vue";
import { useRuntimeStore } from "../stores/runtime";

const store = useRuntimeStore();

const topologyNodes = computed(() => {
  const nodes = store.assets.slice(0, 40);
  const groups = [
    nodes.filter((node) => node.inferredZone === "external-entry" || node.status === "entry"),
    nodes.filter((node) => node.inferredZone !== "external-entry" && node.status !== "service" && node.status !== "entry"),
    nodes.filter((node) => node.status === "service"),
  ].filter((group) => group.length);
  const width = 980;
  const left = 120;
  const usableWidth = width - left * 2;
  const rowGap = 82;
  const groupGap = 44;
  let y = 52;

  return groups.flatMap((group, groupIndex) => {
    const maxPerRow = groupIndex === 0 ? 3 : groupIndex === 1 ? 6 : 7;
    const rows = Math.ceil(group.length / maxPerRow);
    const positioned = group.map((node, index) => {
      const row = Math.floor(index / maxPerRow);
      const rowStart = row * maxPerRow;
      const rowLength = Math.min(maxPerRow, group.length - rowStart);
      const col = index - rowStart;
      const x = rowLength === 1
        ? width / 2
        : left + col * (usableWidth / Math.max(1, rowLength - 1));
      return {
        ...node,
        x,
        y: y + row * rowGap,
        addressLabel: node.id === node.name ? "" : node.id,
        className: node.flagFound ? "flag" : node.accessGained ? "access" : node.status === "service" ? "service" : node.status === "entry" ? "entry" : "host",
      };
    });
    y += rows * rowGap + groupGap;
    return positioned;
  });
});
const topologyHeight = computed(() => {
  const maxY = Math.max(0, ...topologyNodes.value.map((node) => node.y || 0));
  return Math.max(420, Math.ceil(maxY + 74));
});
const topologyNodeMap = computed(() => new Map(topologyNodes.value.map((node) => [node.id, node])));
const topologyEdges = computed(() => store.edges
  .map((edge) => ({
    ...edge,
    fromNode: topologyNodeMap.value.get(edge.from),
    toNode: topologyNodeMap.value.get(edge.to),
  }))
  .filter((edge) => edge.fromNode && edge.toNode)
  .slice(0, 80));
const compactAssets = computed(() => store.assets.filter((item) => item.status !== "service").slice(0, 18));
</script>

<template>
  <section class="panel compact-topology">
    <div class="topology-panel">
      <svg :viewBox="`0 0 980 ${topologyHeight}`" :style="{ aspectRatio: `980 / ${topologyHeight}` }" role="img" aria-label="资产拓扑图">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z"></path>
          </marker>
        </defs>
        <line
          v-for="edge in topologyEdges"
          :key="edge.key"
          class="topology-edge"
          :x1="edge.fromNode?.x"
          :y1="edge.fromNode?.y"
          :x2="edge.toNode?.x"
          :y2="edge.toNode?.y"
        />
        <g v-for="node in topologyNodes" :key="node.id" class="topology-node" :class="node.className" :transform="`translate(${node.x}, ${node.y})`">
          <circle r="14"></circle>
          <text y="28">{{ node.name.length > 16 ? `${node.name.slice(0, 16)}...` : node.name }}</text>
          <text v-if="node.addressLabel" y="41" class="node-address">{{ node.addressLabel.length > 20 ? `${node.addressLabel.slice(0, 20)}...` : node.addressLabel }}</text>
          <text :y="node.addressLabel ? 54 : 41" class="node-subtitle">{{ node.inferredZone || node.status || "node" }}</text>
        </g>
      </svg>
      <div class="topology-legend">
        <span><i class="entry"></i>入口</span>
        <span><i class="host"></i>主机</span>
        <span><i class="service"></i>服务</span>
        <span><i class="access"></i>已获权限</span>
        <span><i class="flag"></i>已获 flag</span>
      </div>
    </div>

    <div class="asset-grid compact">
      <article v-for="node in compactAssets" :key="node.id" class="asset-card">
        <strong>{{ node.name }}</strong>
        <span>{{ node.inferredZone || "unknown" }} · {{ node.status || "discovered" }}</span>
        <small>first {{ node.firstSeenIter || "-" }} · last {{ node.lastSeenIter || "-" }}</small>
      </article>
    </div>
  </section>
</template>
