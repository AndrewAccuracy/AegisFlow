<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRuntimeStore } from "../stores/runtime";

const store = useRuntimeStore();
const overviewLogRef = ref<HTMLElement | null>(null);
const logMode = ref<"clean" | "raw">("clean");
type DisplayLogLine = { text: string; folded?: boolean };

const latest = computed(() => store.latestIteration);
const successfulAttacks = computed(() => {
  return store.iterations
    .filter((item) => (item.flags || []).length || (item.access || []).length)
    .map((item) => ({
      iter: item.iter,
      summary: item.summary || "",
      flags: item.flags || [],
      access: item.access || [],
    }));
});
const recentToolCalls = computed(() => {
  return store.iterations
    .flatMap((item) => (item.toolCalls || []).map((call) => ({ ...call, iter: item.iter })))
    .slice(-8)
    .reverse();
});
const recentActionPreview = computed(() => recentToolCalls.value.slice(0, 4));
const activeProblems = computed(() => {
  return store.iterations
    .flatMap((item) => (item.problems || []).map((problem) => ({ ...problem, iter: item.iter })))
    .slice(-6)
    .reverse();
});
const activeProblemPreview = computed(() => activeProblems.value.slice(0, 3));
const attackMilestones = computed(() => {
  return store.iterations.slice(-8).map((item) => ({
    iter: item.iter,
    summary: item.summary || "暂无摘要",
    status: (item.flags || []).length ? "success" : (item.problems || []).length ? "blocked" : "done",
  }));
});
const flagSources = computed(() => store.flags.flags || []);
const overviewStats = computed(() => [
  { label: "当前轮次", value: store.state.iteration || store.status.iter || 0 },
  { label: "Flags", value: `${store.flagsFound}/${store.flagsNeeded || store.flags.flags?.length || store.flagsFound || 0}` },
  { label: "主机", value: store.hostCount },
  { label: "服务", value: store.serviceCount },
  { label: "凭据", value: store.credentialCount },
  { label: "工具调用", value: store.toolCallCount },
]);
const phaseLabel = computed(() => {
  if (store.run.running) return "运行中";
  if (store.run.recoverable) return "可恢复";
  if (store.status.phase && store.status.phase !== "idle") return store.status.phase;
  return "待命";
});
const phaseTone = computed(() => {
  if (store.run.running) return "running";
  if (store.run.recoverable) return "recoverable";
  if (activeProblems.value.length) return "attention";
  return "idle";
});
const currentPosition = computed(() => latest.value?.position || clipText(latest.value?.summary || "暂无运行摘要。", 140));
const nextStepPreview = computed(() => (latest.value?.nextSteps || []).slice(0, 5).map((step) => clipText(step, 68)));
const hiddenNextSteps = computed(() => Math.max(0, (latest.value?.nextSteps?.length || 0) - nextStepPreview.value.length));
const successPreview = computed(() => successfulAttacks.value.slice(-3).reverse().map((item) => ({
  ...item,
  summary: clipText(item.summary, 150),
})));
const flagPreview = computed(() => flagSources.value.slice(0, 4));
const hiddenFlags = computed(() => Math.max(0, flagSources.value.length - flagPreview.value.length));
const currentSignals = computed(() => [
  {
    label: "可达资产",
    value: `${store.hostCount} 主机 / ${store.serviceCount} 服务`,
  },
  {
    label: "最近动作",
    value: clipText(recentActionPreview.value[0]?.purpose || recentActionPreview.value[0]?.command || "等待下一次工具调用", 48),
  },
  {
    label: "主要风险",
    value: clipText(activeProblemPreview.value[0]?.symptom || "暂无明确阻塞", 48),
  },
]);
const cleanLogLines = computed<DisplayLogLine[]>(() => {
  const lines = store.logLines.map((line) => stripAnsi(line).replace(/\s+$/g, ""));
  const clean: DisplayLogLine[] = [];
  let foldedHtml = 0;

  const flushFoldedHtml = () => {
    if (!foldedHtml) return;
    clean.push({ text: `HTML 响应片段已折叠 ${foldedHtml} 行`, folded: true });
    foldedHtml = 0;
  };

  for (const line of lines) {
    if (looksLikeHtmlLine(line)) {
      foldedHtml += 1;
      continue;
    }
    flushFoldedHtml();
    clean.push({ text: line });
  }

  flushFoldedHtml();
  return clean;
});
const displayedLogLines = computed<DisplayLogLine[]>(() => {
  if (logMode.value === "raw") {
    return store.logLines.map((line) => ({ text: stripAnsi(line).replace(/\s+$/g, "") }));
  }
  return cleanLogLines.value;
});
const foldedLineCount = computed(() => cleanLogLines.value.filter((line) => line.folded).length);

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function looksLikeHtmlLine(line: string) {
  const text = line.trim();
  if (!text) return false;
  if (/^<!doctype/i.test(text)) return true;
  if (/^<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(text)) return true;
  return /<\/(html|head|body|main|table|tr|td|th|style|script|div|span|code)>/i.test(text);
}

function clipText(text: string, maxLength: number) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}...`;
}

watch(
  () => displayedLogLines.value.map((line) => line.text).join("\n"),
  async () => {
    await nextTick();
    if (overviewLogRef.value) overviewLogRef.value.scrollTop = overviewLogRef.value.scrollHeight;
  },
  { flush: "post" },
);
</script>

<template>
  <section class="overview-cockpit">
    <div class="overview-command-bar">
      <article class="overview-status-card" :class="phaseTone">
        <span>Mission Status</span>
        <strong>{{ phaseLabel }}</strong>
        <p>{{ store.target }}</p>
      </article>
      <article v-for="item in overviewStats" :key="item.label" class="overview-stat-card">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </article>
    </div>

    <div class="overview-dashboard">
      <section class="overview-now">
        <div class="overview-panel-head">
          <div>
            <span>Current Position</span>
            <h2>当前态势</h2>
          </div>
          <strong>第 {{ store.state.iteration || store.status.iter || 0 }} 轮</strong>
        </div>
        <p class="overview-position">{{ currentPosition }}</p>
        <div class="milestone-strip">
          <div v-for="item in attackMilestones" :key="item.iter" class="milestone" :class="item.status">
            <strong>{{ item.iter }}</strong>
            <span>{{ item.status === "success" ? "成功" : item.status === "blocked" ? "受阻" : "完成" }}</span>
          </div>
        </div>
        <div class="overview-signal-grid">
          <div v-for="signal in currentSignals" :key="signal.label" class="overview-signal">
            <span>{{ signal.label }}</span>
            <strong>{{ signal.value }}</strong>
          </div>
        </div>
      </section>

      <section class="overview-next">
        <div class="overview-panel-head">
          <div>
            <span>Next Actions</span>
            <h2>下一步</h2>
          </div>
          <strong>{{ latest?.nextSteps?.length || 0 }} 项</strong>
        </div>
        <div v-if="nextStepPreview.length" class="next-step-grid">
          <div v-for="(item, index) in nextStepPreview" :key="item" class="next-step-chip">
            <span>{{ index + 1 }}</span>
            <strong>{{ item }}</strong>
          </div>
          <div v-if="hiddenNextSteps" class="next-step-chip muted">
            <span>+</span>
            <strong>还有 {{ hiddenNextSteps }} 项在决策页查看</strong>
          </div>
        </div>
        <p v-else class="note-empty">暂无下一步建议。</p>
      </section>
    </div>

    <div class="overview-lanes">
      <section class="overview-lane">
        <div class="overview-panel-head">
          <div>
            <span>Recent Actions</span>
            <h2>行动流</h2>
          </div>
          <strong>{{ recentToolCalls.length }} 条</strong>
        </div>
        <ul v-if="recentActionPreview.length" class="overview-feed">
          <li v-for="call in recentActionPreview" :key="`${call.iter}-${call.command}`">
            <span>R{{ call.iter }} · {{ call.tool || "shell" }}</span>
            <strong>{{ call.purpose || clipText(call.command || "", 72) }}</strong>
            <small>{{ clipText(call.impact || call.result || "-", 92) }}</small>
          </li>
        </ul>
        <p v-else class="note-empty">暂无工具调用记录。</p>
      </section>

      <section class="overview-lane risk">
        <div class="overview-panel-head">
          <div>
            <span>Risks</span>
            <h2>风险</h2>
          </div>
          <strong>{{ activeProblems.length }} 个</strong>
        </div>
        <ul v-if="activeProblemPreview.length" class="overview-feed">
          <li v-for="problem in activeProblemPreview" :key="`${problem.iter}-${problem.symptom}-${problem.cause}`">
            <span>R{{ problem.iter }}</span>
            <strong>{{ clipText(problem.symptom || "阻塞待确认", 60) }}</strong>
            <small>{{ clipText(problem.resolution || problem.cause || "-", 92) }}</small>
          </li>
        </ul>
        <div v-else class="risk-empty">
          <strong>暂无明确阻塞</strong>
          <span>当前没有需要人工介入的风险记录。</span>
        </div>
      </section>
    </div>

    <div class="overview-evidence">
      <section class="overview-success">
        <div class="overview-panel-head">
          <div>
            <span>Wins</span>
            <h2>已确认成果</h2>
          </div>
          <strong>{{ successfulAttacks.length }} 轮</strong>
        </div>
        <div v-if="successPreview.length" class="overview-win-grid">
          <article v-for="item in successPreview" :key="item.iter" class="overview-win-card">
            <span>第 {{ item.iter }} 轮</span>
            <p>{{ item.summary }}</p>
            <div class="flag-meta">
              <span v-for="flag in item.flags.slice(0, 2)" :key="flag">{{ flag }}</span>
              <span v-for="access in item.access.slice(0, 2)" :key="access">{{ access }}</span>
            </div>
          </article>
        </div>
        <p v-else class="note-empty">暂未记录成功利用或 flag。</p>
      </section>

      <section class="overview-flags">
        <div class="overview-panel-head">
          <div>
            <span>Flags</span>
            <h2>Flag 获取</h2>
          </div>
          <strong>{{ flagSources.length }}</strong>
        </div>
        <ul v-if="flagPreview.length" class="overview-flag-list">
          <li v-for="flag in flagPreview" :key="flag.value">
            <code>{{ flag.value }}</code>
            <span>{{ flag.source || flag.evidence?.method || "来源待确认" }}</span>
          </li>
          <li v-if="hiddenFlags" class="muted">还有 {{ hiddenFlags }} 个 flag 在 Flags 页查看</li>
        </ul>
        <p v-else class="note-empty">尚未识别到 flag。</p>
      </section>
    </div>

    <details class="overview-log-drawer">
      <summary>
        <span>运行日志</span>
        <strong>最近 {{ store.logLines.length }} 行 · 折叠 {{ foldedLineCount }} 段</strong>
      </summary>
      <div class="log-heading">
        <div class="log-mode-switch" aria-label="日志显示方式">
          <button type="button" :class="{ active: logMode === 'clean' }" @click="logMode = 'clean'">整理</button>
          <button type="button" :class="{ active: logMode === 'raw' }" @click="logMode = 'raw'">原文</button>
        </div>
      </div>
      <div ref="overviewLogRef" class="log-viewer overview-log-viewer" role="log" aria-live="polite">
        <div v-if="displayedLogLines.length" class="log-lines">
          <div
            v-for="(line, index) in displayedLogLines"
            :key="`${index}-${line.text}`"
            class="log-line"
            :class="{ folded: line.folded }"
          >
            <span class="log-line-number">{{ index + 1 }}</span>
            <span class="log-line-text">{{ line.text || " " }}</span>
          </div>
        </div>
        <p v-else class="log-empty">暂无日志。</p>
      </div>
    </details>
  </section>
</template>
