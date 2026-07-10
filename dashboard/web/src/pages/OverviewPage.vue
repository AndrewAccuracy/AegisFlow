<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRuntimeStore } from "../stores/runtime";

const store = useRuntimeStore();
const overviewLogRef = ref<HTMLElement | null>(null);

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
const activeProblems = computed(() => {
  return store.iterations
    .flatMap((item) => (item.problems || []).map((problem) => ({ ...problem, iter: item.iter })))
    .slice(-6)
    .reverse();
});
const attackMilestones = computed(() => {
  return store.iterations.slice(-8).map((item) => ({
    iter: item.iter,
    summary: item.summary || "暂无摘要",
    status: (item.flags || []).length ? "success" : (item.problems || []).length ? "blocked" : "done",
  }));
});
const flagSources = computed(() => store.flags.flags || []);

watch(
  () => store.logLines.join("\n"),
  async () => {
    await nextTick();
    if (overviewLogRef.value) overviewLogRef.value.scrollTop = overviewLogRef.value.scrollHeight;
  },
  { flush: "post" },
);
</script>

<template>
  <section class="grid overview-grid">
    <article class="metric">
      <span>当前轮次</span>
      <strong>{{ store.state.iteration || store.status.iter || 0 }}</strong>
    </article>
    <article class="metric">
      <span>Flags</span>
      <strong>{{ store.flagsFound }}</strong>
    </article>
    <article class="metric">
      <span>已发现主机</span>
      <strong>{{ store.hostCount }}</strong>
    </article>
    <article class="metric">
      <span>服务</span>
      <strong>{{ store.serviceCount }}</strong>
    </article>
    <article class="metric">
      <span>凭据</span>
      <strong>{{ store.credentialCount }}</strong>
    </article>
    <article class="metric">
      <span>工具调用</span>
      <strong>{{ store.toolCallCount }}</strong>
    </article>
    <article class="panel overview-pair overview-focus overview-full">
      <div class="section-title compact">
        <div>
          <h2>当前攻击位置</h2>
          <p>{{ latest?.position || latest?.summary || "暂无运行摘要。" }}</p>
        </div>
      </div>
      <div class="milestone-strip">
        <div v-for="item in attackMilestones" :key="item.iter" class="milestone" :class="item.status">
          <strong>{{ item.iter }}</strong>
          <span>{{ item.status === "success" ? "成功" : item.status === "blocked" ? "受阻" : "完成" }}</span>
        </div>
      </div>
      <h3>下一步建议</h3>
      <ul>
        <li v-for="item in latest?.nextSteps || []" :key="item">{{ item }}</li>
      </ul>
    </article>
    <article class="panel overview-pair overview-full">
      <h2>已成功攻击</h2>
      <div v-if="successfulAttacks.length" class="success-list">
        <article v-for="item in successfulAttacks" :key="item.iter" class="success-item">
          <strong>第 {{ item.iter }} 轮</strong>
          <p>{{ item.summary }}</p>
          <div v-if="item.flags.length" class="flag-meta">
            <span v-for="flag in item.flags" :key="flag">{{ flag }}</span>
          </div>
          <div v-if="item.access.length" class="flag-meta">
            <span v-for="access in item.access" :key="access">{{ access }}</span>
          </div>
        </article>
      </div>
      <p v-else>暂未记录成功利用或 flag。</p>
    </article>
    <article class="panel overview-pair">
      <h2>运行状态</h2>
      <dl>
        <dt>阶段</dt><dd>{{ store.status.plan || "无" }}</dd>
        <dt>输出</dt><dd>{{ store.status.bytes || 0 }} bytes</dd>
        <dt>更新时间</dt><dd>{{ store.lastRefresh || "-" }}</dd>
      </dl>
    </article>
    <article class="panel overview-pair">
      <h2>Flag 获取情况</h2>
      <ul v-if="flagSources.length" class="compact-list">
        <li v-for="flag in flagSources" :key="flag.value">
          <code>{{ flag.value }}</code>
          <span>{{ flag.source || flag.evidence?.method || "来源待确认" }}</span>
        </li>
      </ul>
      <p v-else>尚未识别到 flag。</p>
    </article>
    <article class="panel overview-pair">
      <h2>最近攻击动作</h2>
      <ul v-if="recentToolCalls.length" class="action-list">
        <li v-for="call in recentToolCalls" :key="`${call.iter}-${call.command}`">
          <strong>第 {{ call.iter }} 轮 · {{ call.tool || "shell" }}</strong>
          <span>{{ call.purpose || call.command }}</span>
          <small>{{ call.impact || call.result || "-" }}</small>
        </li>
      </ul>
      <p v-else>暂无工具调用记录。</p>
    </article>
    <article class="panel overview-pair">
      <h2>当前阻塞与风险</h2>
      <ul v-if="activeProblems.length" class="problem-list">
        <li v-for="problem in activeProblems" :key="`${problem.iter}-${problem.symptom}-${problem.cause}`">
          <strong>第 {{ problem.iter }} 轮 · {{ problem.symptom }}</strong>
          <span>{{ problem.cause }}</span>
          <small>{{ problem.resolution }}</small>
        </li>
      </ul>
      <p v-else>暂无明确阻塞。</p>
    </article>
    <article class="panel overview-log">
      <div class="section-title compact">
        <div>
          <h2>原始日志</h2>
          <p>最近 {{ store.logLines.length }} 行</p>
        </div>
      </div>
      <pre ref="overviewLogRef" class="log-viewer overview-log-viewer">{{ store.logLines.join('\n') }}</pre>
    </article>
  </section>
</template>
