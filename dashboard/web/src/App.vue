<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import AppHeader from "./components/AppHeader.vue";
import { navItems, type NavKey } from "./config/navigation";
import LandingPage from "./pages/LandingPage.vue";
import OverviewPage from "./pages/OverviewPage.vue";
import StartPage from "./pages/StartPage.vue";
import TopologyPage from "./pages/TopologyPage.vue";
import { useRuntimeStore } from "./stores/runtime";

const store = useRuntimeStore();
const navKeys = new Set<NavKey>(navItems.map((item) => item.key));
const active = ref<NavKey>(getHashTab());
const showLanding = ref(!window.location.hash);
let refreshTimer: number | undefined;
const renderedNote = computed(() => renderMarkdown(store.activeNote?.content || ""));
const timelineItems = computed(() => {
  return store.iterations.map((item) => {
    const flagCount = item.flags?.length || 0;
    const problemCount = item.problems?.length || 0;
    const accessCount = item.access?.length || 0;
    const status = flagCount ? "success" : problemCount ? "blocked" : "progress";
    return {
      ...item,
      status,
      statusLabel: status === "success" ? "拿到 flag" : status === "blocked" ? "遇到阻塞" : "推进中",
      flagCount,
      problemCount,
      accessCount,
      hostCount: item.hosts?.length || 0,
      serviceCount: item.services?.length || 0,
      toolCount: item.toolCalls?.length || 0,
      displayTime: formatTimelineTime(item.time),
      nextStepPreview: (item.nextSteps || []).slice(0, 3),
      primaryOutcome: item.flags?.[0] || item.access?.[0] || item.position || item.summary || "本轮尚未形成明确成果",
      summaryPreview: item.summary && item.summary.length > 170 ? `${item.summary.slice(0, 170)}...` : item.summary,
    };
  });
});
const timelineStats = computed(() => ({
  rounds: store.iterations.length,
  flags: store.flagsFound,
  hosts: new Set(store.iterations.flatMap((item) => item.hosts || [])).size,
  tools: store.iterations.reduce((sum, item) => sum + (item.toolCalls?.length || 0), 0),
  risks: store.iterations.reduce((sum, item) => sum + (item.problems?.length || 0), 0),
}));
const findingItems = computed(() => {
  return store.iterations.map((item) => {
    const hosts = uniqueClean(item.hosts || []).slice(0, 18);
    const services = uniqueClean((item.services || []).map((service) => {
      const host = service.host || "?";
      const port = service.port || "?";
      const name = service.name ? ` ${service.name}` : "";
      return `${host}:${port}${name}`;
    })).slice(0, 18);
    const credentials = uniqueClean((item.credentials || [])
      .map((credential) => formatCredential(credential))
      .filter((label): label is string => Boolean(label)))
      .slice(0, 10);
    const intel = uniqueClean(item.intel || []).slice(0, 6);
    const summary = item.summary || "";

    return {
      ...item,
      hosts,
      services,
      credentials,
      intel,
      summaryPreview: summary.length > 150 ? `${summary.slice(0, 150)}...` : summary,
      problemCount: item.problems?.length || 0,
      toolCount: item.toolCalls?.length || 0,
      scopeCount: hosts.length + services.length + credentials.length + intel.length,
      hiddenHosts: Math.max(0, (item.hosts?.length || 0) - hosts.length),
      hiddenServices: Math.max(0, (item.services?.length || 0) - services.length),
      hiddenCredentials: Math.max(0, (item.credentials?.length || 0) - credentials.length),
      hiddenIntel: Math.max(0, (item.intel?.length || 0) - intel.length),
    };
  });
});
const findingStats = computed(() => ({
  hosts: new Set(store.iterations.flatMap((item) => item.hosts || [])).size,
  services: store.iterations.reduce((sum, item) => sum + (item.services?.length || 0), 0),
  credentials: findingItems.value.reduce((sum, item) => sum + item.credentials.length, 0),
  intel: store.iterations.reduce((sum, item) => sum + (item.intel?.length || 0), 0),
}));
const noteStats = computed(() => ({
  count: store.notes.length,
  totalKb: Math.max(1, Math.ceil(store.notes.reduce((sum, note) => sum + note.size, 0) / 1024)),
  activeUpdatedAt: store.activeNote?.updatedAt ? formatTimelineTime(store.activeNote.updatedAt) : "-",
}));
const evidenceGroups = computed(() => {
  return store.iterations
    .map((item) => ({
      iter: item.iter,
      summary: item.summary || "",
      calls: (item.toolCalls || []).map((call, index) => ({
        ...call,
        id: `${item.iter}-${index}-${call.command || call.purpose || call.tool || "call"}`,
        commandLabel: compactCommand(call.command || ""),
      })),
    }))
    .filter((item) => item.calls.length);
});
const evidenceStats = computed(() => {
  const calls = evidenceGroups.value.flatMap((item) => item.calls);
  return {
    calls: calls.length,
    tools: new Set(calls.map((call) => call.tool || "shell")).size,
    rounds: evidenceGroups.value.length,
  };
});
const flagGroups = computed(() => {
  const groups = new Map<number | string, typeof store.flags.flags>();
  for (const flag of store.flags.flags || []) {
    const key = flag.evidence?.iter ?? "unknown";
    groups.set(key, [...(groups.get(key) || []), flag]);
  }
  return [...groups.entries()].map(([iter, flags]) => ({
    iter,
    label: iter === "unknown" ? "未归档轮次" : `第 ${iter} 轮`,
    flags: flags || [],
  }));
});
const flagProgress = computed(() => {
  const found = store.flagsFound;
  const needed = store.flagsNeeded || store.flags.flags?.length || found;
  const percent = needed ? Math.min(100, Math.round((found / needed) * 100)) : 0;
  return { found, needed, percent };
});
const strategyStats = computed(() => ({
  rounds: store.iterations.length,
  decisions: store.iterations.reduce((sum, item) => sum + (item.nextSteps?.length || 0), 0),
  highRewards: store.iterations.filter((item) => /high|complete|高|额外|完整/i.test(item.rewardEvaluation?.level || "")).length,
}));
const strategyItems = computed(() => store.iterations.map((item) => ({
  ...item,
  level: item.rewardEvaluation?.level || "pending",
  reason: item.rewardEvaluation?.reason || "暂无奖励评估。",
  summaryPreview: clipText(cleanNoteText(item.summary || ""), 150),
  flagPreview: (item.flags || []).slice(0, 2),
  accessPreview: (item.access || []).slice(0, 2),
  problemPreview: (item.problems || []).slice(0, 2).map((problem) => cleanNoteText(problem.symptom || problem.cause || "")),
  visibleSteps: (item.nextSteps || []).slice(0, 3),
  hiddenSteps: Math.max(0, (item.nextSteps?.length || 0) - 3),
})));
const structuredNote = computed(() => parseStructuredNote(store.activeNote?.content || ""));
const noteContentStats = computed(() => ({
  sections: structuredNote.value.sections.length,
  checks: structuredNote.value.sections.reduce((sum, section) => sum + (section.table?.rows.length || 0), 0),
  items: structuredNote.value.sections.reduce((sum, section) => sum + section.items.length, 0),
  paragraphs: structuredNote.value.sections.reduce((sum, section) => sum + section.body.length, 0),
}));
const strategyChecklist = computed(() => {
  const rows = structuredNote.value.sections.find((section) => section.table?.rows.length)?.table?.rows || [];
  return rows.slice(0, 4).map((row) => ({
    target: row[0] || "检查项",
    status: row[1] || "待确认",
    note: row[2] || "",
  }));
});
const strategyReviewSections = computed(() => structuredNote.value.sections
  .filter((section) => !section.table?.rows.length)
  .slice(0, 2)
  .map((section) => ({
    title: section.title,
    items: section.items.slice(0, 2).map((item) => clipText(cleanNoteText(item), 72)),
    body: section.body.slice(0, 1).map((item) => clipText(cleanNoteText(item), 92)),
  }))
  .filter((section) => section.items.length || section.body.length));

function setActive(value: NavKey) {
  showLanding.value = false;
  active.value = value;
  window.history.replaceState(null, "", `#${value}`);
  resetPagePosition();
}

function enterDashboard() {
  setActive("start");
}

function goHome() {
  showLanding.value = true;
  window.history.replaceState(null, "", window.location.pathname);
  resetPagePosition();
}

function getHashTab() {
  const hashTab = window.location.hash.slice(1) as NavKey;
  return navKeys.has(hashTab) ? hashTab : "start";
}

function resetPagePosition() {
  nextTick(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  });
}

function handleHashChange() {
  showLanding.value = !window.location.hash;
  active.value = getHashTab();
  resetPagePosition();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text: string) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(item[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return html.join("");
}

function clipText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}

function parseStructuredNote(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || formatNoteName(store.activeNote?.name || "笔记");
  const sections: Array<{ title: string; body: string[]; table?: { headers: string[]; rows: string[][] }; items: string[] }> = [];
  let current: { title: string; body: string[]; table?: { headers: string[]; rows: string[][] }; items: string[] } | null = null;

  const ensureSection = (name = "摘要") => {
    if (!current) {
      current = { title: name, body: [], items: [] };
      sections.push(current);
    }
    return current;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("# ")) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { title: heading[1].trim(), body: [], items: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("|") && isMarkdownTableDivider(lines[i + 1]?.trim() || "")) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i].trim()));
        i += 1;
      }
      i -= 1;
      ensureSection().table = { headers, rows };
      continue;
    }
    const item = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (item) {
      ensureSection().items.push(cleanNoteText(item[1]));
    } else {
      ensureSection().body.push(cleanNoteText(line));
    }
  }

  return { title, sections };
}

function isMarkdownTableDivider(line: string) {
  if (!line.startsWith("|")) return false;
  return line
    .replace(/\|/g, "")
    .trim()
    .split(/\s+/)
    .join("")
    .split("")
    .every((char) => char === "-" || char === ":");
}

function parseTableRow(row: string) {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cleanNoteText(cell));
}

function cleanNoteText(text: string) {
  return String(text || "")
    .trim()
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function formatNoteName(name: string) {
  const base = String(name || "笔记").replace(/\.[^.]+$/, "");
  const round = base.match(/^r(\d+)_summary$/i);
  if (round) return `第 ${round[1]} 轮复盘`;
  if (/final[_-]demo[_-]report/i.test(base)) return "最终演示报告";
  return base
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "笔记";
}

function formatTimelineTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function uniqueClean(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || "").trim().replace(/\s+/g, " ");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function formatCredential(credential: { username?: string; password?: string; host?: string; service?: string }) {
  const username = String(credential.username || "").trim();
  const password = String(credential.password || "").trim();
  const host = String(credential.host || credential.service || "").trim();
  const noise = /^(?:\?|http|https|http_code|content_type|server|size|len|fail|clear|div|td|table-layout|word-wrap|font-size|display|og|api|gcc_version|redis_version|redis_mode|redis_build_id|os|run_id|enable_strict_lua|io|ff|0a|00|05|nhttp|nserver)$/i;
  if (!username || noise.test(username)) return "";
  if (!password && (!host || host === "?" || noise.test(host))) return "";
  const account = password ? `${username}:${password}` : username;
  return host && host !== "?" ? `${account} @ ${host}` : account;
}

function compactCommand(command: string) {
  const text = String(command || "").trim().replace(/\s+/g, " ");
  if (!text) return "未记录命令";
  return text.length > 92 ? `${text.slice(0, 92)}...` : text;
}

onMounted(async () => {
  window.addEventListener("hashchange", handleHashChange);
  resetPagePosition();
  await store.refreshAll();
  store.connectEvents();
  refreshTimer = window.setInterval(() => store.refreshAll(), 3000);
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", handleHashChange);
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <LandingPage v-if="showLanding" @enter="enterDashboard" />

  <div v-else class="shell">
    <div class="aurora-layer app-aurora" aria-hidden="true"></div>

    <AppHeader :active="active" @go-home="goHome" @update:active="setActive" />

    <main class="content">
      <StartPage v-if="active === 'start'" @navigate="setActive" />
      <OverviewPage v-else-if="active === 'overview'" />
      <TopologyPage v-else-if="active === 'assets'" />

      <section v-else-if="active === 'timeline'" class="timeline timeline-page">
        <div class="timeline-summary">
          <article>
            <span>轮次</span>
            <strong>{{ timelineStats.rounds }}</strong>
          </article>
          <article>
            <span>Flags</span>
            <strong>{{ timelineStats.flags }}</strong>
          </article>
          <article>
            <span>主机</span>
            <strong>{{ timelineStats.hosts }}</strong>
          </article>
          <article>
            <span>工具调用</span>
            <strong>{{ timelineStats.tools }}</strong>
          </article>
          <article>
            <span>阻塞</span>
            <strong>{{ timelineStats.risks }}</strong>
          </article>
        </div>

        <div class="timeline-stage">
          <div class="timeline-stage-head">
            <div>
              <span>Replay</span>
              <h2>攻击进程回放</h2>
            </div>
            <strong>{{ store.lastRefresh || "实时同步" }}</strong>
          </div>

          <div class="timeline-stepper">
            <article v-for="item in timelineItems" :key="`step-${item.iter}`" class="timeline-step" :class="item.status">
              <span>{{ item.iter }}</span>
              <strong>{{ item.statusLabel }}</strong>
              <small>{{ item.flagCount }} flag · {{ item.toolCount }} tools</small>
            </article>
          </div>
        </div>

        <div class="timeline-rounds">
          <article v-for="item in timelineItems" :key="item.iter" class="timeline-round-card" :class="item.status">
            <div class="timeline-round-number">
              <span>{{ String(item.iter).padStart(2, "0") }}</span>
            </div>

            <div class="timeline-round-main">
              <div class="timeline-card-head">
                <div>
                  <span class="timeline-kicker">Round {{ String(item.iter).padStart(2, "0") }} · {{ item.displayTime }}</span>
                  <h2>{{ item.position || `第 ${item.iter} 轮行动` }}</h2>
                </div>
                <span class="timeline-state">{{ item.statusLabel }}</span>
              </div>

              <p>{{ item.summaryPreview || "暂无摘要。" }}</p>

              <div class="timeline-metrics">
                <span>{{ item.hostCount }} 主机</span>
                <span>{{ item.serviceCount }} 服务</span>
                <span>{{ item.toolCount }} 工具</span>
                <span>{{ item.accessCount }} 权限</span>
              </div>

              <div class="timeline-insight-grid">
                <section class="timeline-insight outcome">
                  <strong>本轮结果</strong>
                  <span>{{ item.primaryOutcome }}</span>
                  <div v-if="item.flags?.length" class="timeline-chip-row">
                    <code v-for="flag in item.flags.slice(0, 2)" :key="flag">{{ flag }}</code>
                  </div>
                </section>

                <section class="timeline-insight" :class="{ blocked: item.problems?.length }">
                  <strong>{{ item.problems?.length ? "阻塞点" : "状态" }}</strong>
                  <span v-if="item.problems?.length">
                    {{ item.problems[0].symptom || item.problems[0].cause || "待确认" }}
                  </span>
                  <span v-else>本轮未记录明确阻塞。</span>
                </section>

                <section class="timeline-insight next">
                  <strong>下一步</strong>
                  <template v-if="item.nextStepPreview.length">
                    <span v-for="step in item.nextStepPreview" :key="step">{{ step }}</span>
                  </template>
                  <span v-else>暂无下一步建议。</span>
                </section>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section v-else-if="active === 'findings'" class="findings-page">
        <div class="finding-summary">
          <article>
            <span>主机</span>
            <strong>{{ findingStats.hosts }}</strong>
          </article>
          <article>
            <span>服务</span>
            <strong>{{ findingStats.services }}</strong>
          </article>
          <article>
            <span>有效凭据</span>
            <strong>{{ findingStats.credentials }}</strong>
          </article>
          <article>
            <span>情报</span>
            <strong>{{ findingStats.intel }}</strong>
          </article>
        </div>

        <article v-for="item in findingItems" :key="item.iter" class="finding-card">
          <div class="finding-head">
            <div>
              <span>Round {{ String(item.iter).padStart(2, "0") }}</span>
              <h2>{{ item.position || `第 ${item.iter} 轮发现` }}</h2>
            </div>
            <strong>{{ item.scopeCount }} items</strong>
          </div>

          <div class="finding-body">
            <section class="finding-brief">
              <p>{{ item.summaryPreview || "暂无摘要。" }}</p>
              <div class="finding-signal-row">
                <span>{{ item.hosts.length }} 主机</span>
                <span>{{ item.services.length }} 服务</span>
                <span>{{ item.credentials.length }} 凭据</span>
                <span>{{ item.toolCount }} 工具</span>
                <span :class="{ alert: item.problemCount }">{{ item.problemCount }} 阻塞</span>
              </div>
            </section>

            <div class="finding-grid">
              <section class="finding-block hosts-block">
                <div class="finding-block-head">
                  <h3>Hosts</h3>
                  <strong>{{ item.hosts.length }}</strong>
                </div>
                <div v-if="item.hosts.length" class="finding-chips compact">
                  <code v-for="host in item.hosts.slice(0, 12)" :key="host">{{ host }}</code>
                  <span v-if="item.hiddenHosts">+{{ item.hiddenHosts }}</span>
                </div>
                <p v-else>暂无主机。</p>
              </section>

              <section class="finding-block services-block">
                <div class="finding-block-head">
                  <h3>Services</h3>
                  <strong>{{ item.services.length }}</strong>
                </div>
                <div v-if="item.services.length" class="finding-service-list">
                  <code v-for="service in item.services.slice(0, 7)" :key="service">{{ service }}</code>
                  <span v-if="item.hiddenServices">还有 {{ item.hiddenServices }} 个服务</span>
                </div>
                <p v-else>暂无服务。</p>
              </section>

              <section class="finding-block credential-block">
                <div class="finding-block-head">
                  <h3>Credentials</h3>
                  <strong>{{ item.credentials.length }}</strong>
                </div>
                <div v-if="item.credentials.length" class="finding-chips">
                  <code v-for="credential in item.credentials.slice(0, 5)" :key="credential">{{ credential }}</code>
                  <span v-if="item.hiddenCredentials">+{{ item.hiddenCredentials }}</span>
                </div>
                <p v-else>暂无有效凭据。</p>
              </section>

              <section class="finding-block intel-block">
                <div class="finding-block-head">
                  <h3>Intel</h3>
                  <strong>{{ item.intel.length }}</strong>
                </div>
                <ul v-if="item.intel.length">
                  <li v-for="intel in item.intel.slice(0, 4)" :key="intel">{{ intel }}</li>
                  <li v-if="item.hiddenIntel">还有 {{ item.hiddenIntel }} 条情报</li>
                </ul>
                <p v-else>暂无情报。</p>
              </section>
            </div>
          </div>
        </article>
      </section>

      <section v-else-if="active === 'tools'" class="evidence-page">
        <div class="evidence-summary">
          <article>
            <span>证据动作</span>
            <strong>{{ evidenceStats.calls }}</strong>
          </article>
          <article>
            <span>工具类型</span>
            <strong>{{ evidenceStats.tools }}</strong>
          </article>
          <article>
            <span>覆盖轮次</span>
            <strong>{{ evidenceStats.rounds }}</strong>
          </article>
        </div>

        <article v-for="group in evidenceGroups" :key="group.iter" class="evidence-round">
          <div class="evidence-round-head">
            <div>
              <span>Round {{ String(group.iter).padStart(2, "0") }}</span>
              <h2>第 {{ group.iter }} 轮证据</h2>
            </div>
            <strong>{{ group.calls.length }} 条</strong>
          </div>

          <div class="evidence-list">
            <section v-for="call in group.calls" :key="call.id" class="evidence-card">
              <div class="evidence-card-head">
                <strong>{{ call.tool || "shell" }}</strong>
                <span>{{ call.purpose || "未记录目的" }}</span>
              </div>
              <code>{{ call.commandLabel }}</code>
              <p>{{ call.impact || call.result || "影响待确认" }}</p>
            </section>
          </div>
        </article>

        <p v-if="!evidenceGroups.length" class="note-empty">暂无证据动作。</p>
      </section>

      <section v-else-if="active === 'flags'" class="flags-page">
        <div class="flag-hero">
          <div>
            <span>Flag 收集进度</span>
            <strong>{{ flagProgress.found }} / {{ flagProgress.needed }}</strong>
            <p>{{ store.flags.target || store.target }}</p>
          </div>
          <div class="flag-progress-ring" :style="{ '--progress': `${flagProgress.percent}%` }">
            <span>{{ flagProgress.percent }}%</span>
          </div>
        </div>

        <article v-for="group in flagGroups" :key="String(group.iter)" class="flag-round">
          <div class="flag-round-head">
            <div>
              <span>Round</span>
              <h2>{{ group.label }}</h2>
            </div>
            <strong>{{ group.flags.length }} flags</strong>
          </div>

          <div class="flag-card-grid">
            <section v-for="flag in group.flags" :key="flag.value" class="flag-card">
              <code>{{ flag.value }}</code>
              <div class="flag-meta">
                <span>{{ flag.source || "来源待确认" }}</span>
                <span>{{ flag.evidence?.method || "方法待确认" }}</span>
              </div>
              <p v-if="flag.evidence?.summary">{{ flag.evidence.summary }}</p>
              <pre v-if="flag.evidence?.command">{{ compactCommand(flag.evidence.command) }}</pre>
            </section>
          </div>
        </article>

        <p v-if="!flagGroups.length" class="note-empty">尚未识别到 flag。</p>
      </section>

      <section v-else-if="active === 'notes'" class="notes-workspace">
        <div class="note-library-board">
          <article class="note-library-card">
            <span>复盘资料库</span>
            <strong>{{ noteStats.count }}</strong>
            <p>{{ noteStats.totalKb }} KB · artifacts/notes</p>
          </article>

          <div class="note-list-panel">
            <button
              v-for="note in store.notes"
              :key="note.name"
              class="note-item"
              :class="{ active: store.activeNote?.name === note.name }"
              @click="store.loadNote(note.name)"
            >
              <strong>{{ formatNoteName(note.name) }}</strong>
              <span>{{ Math.ceil(note.size / 1024) }} KB</span>
              <small>{{ formatTimelineTime(note.updatedAt) }}</small>
            </button>
            <p v-if="!store.notes.length" class="note-empty">暂无笔记文件。</p>
          </div>
        </div>

        <article class="note-reader">
          <div class="note-reader-head">
            <div>
              <h2>{{ structuredNote.title || "请选择笔记" }}</h2>
              <p>{{ noteStats.activeUpdatedAt }}</p>
            </div>
            <span>复盘报告</span>
          </div>

          <div v-if="store.activeNote?.content" class="note-report-dashboard">
            <div class="note-report-hero">
              <div>
                <span>Report Snapshot</span>
                <h1>{{ structuredNote.title }}</h1>
                <p>{{ noteStats.activeUpdatedAt }}</p>
              </div>
              <div class="note-report-metrics">
                <article>
                  <span>章节</span>
                  <strong>{{ noteContentStats.sections }}</strong>
                </article>
                <article>
                  <span>检查项</span>
                  <strong>{{ noteContentStats.checks }}</strong>
                </article>
                <article>
                  <span>要点</span>
                  <strong>{{ noteContentStats.items + noteContentStats.paragraphs }}</strong>
                </article>
              </div>
            </div>

            <section v-for="section in structuredNote.sections" :key="section.title" class="note-section" :class="{ 'has-table': section.table }">
              <div class="note-section-head">
                <h2>{{ section.title }}</h2>
                <strong>{{ (section.table?.rows.length || 0) + section.items.length + section.body.length }}</strong>
              </div>
              <div v-if="section.table" class="note-status-table">
                <div class="note-table-head">
                  <span v-for="header in section.table.headers" :key="header">{{ header }}</span>
                </div>
                <div v-for="(row, rowIndex) in section.table.rows" :key="`${section.title}-${rowIndex}`" class="note-table-row">
                  <span v-for="(cell, cellIndex) in row" :key="`${cell}-${cellIndex}`" :class="{ status: cellIndex === 1 }">
                    {{ cell }}
                  </span>
                </div>
              </div>
              <p v-for="paragraph in section.body" :key="paragraph">{{ paragraph }}</p>
              <ul v-if="section.items.length" class="note-section-list">
                <li v-for="item in section.items" :key="item">{{ item }}</li>
              </ul>
            </section>
          </div>
          <p v-else class="note-empty">暂无笔记内容。</p>
        </article>
      </section>

      <section v-else-if="active === 'strategy'" class="strategy-page">
        <div class="strategy-hero">
          <article class="strategy-intro">
            <span>Decision Review</span>
            <h1>决策复盘</h1>
            <p>把每轮奖励判断、下一步计划和复盘检查放在同一个视野里，避免侧边栏变成另一篇长文档。</p>
          </article>
          <div class="strategy-summary">
            <article>
              <span>轮次</span>
              <strong>{{ strategyStats.rounds }}</strong>
            </article>
            <article>
              <span>决策项</span>
              <strong>{{ strategyStats.decisions }}</strong>
            </article>
            <article>
              <span>高价值轮次</span>
              <strong>{{ strategyStats.highRewards }}</strong>
            </article>
          </div>
        </div>

        <div class="strategy-layout">
          <section class="strategy-decisions">
            <div class="strategy-section-head">
              <div>
                <span>Round Decisions</span>
                <h2>决策主线</h2>
              </div>
              <strong>{{ strategyItems.length }} 轮</strong>
            </div>
            <article v-for="item in strategyItems" :key="item.iter" class="decision-card">
              <div class="decision-index">
                <span>Round</span>
                <strong>{{ item.iter }}</strong>
              </div>
              <div class="decision-content">
                <div class="decision-head">
                  <div>
                    <span>{{ item.level }}</span>
                    <h2>第 {{ item.iter }} 轮决策</h2>
                  </div>
                </div>
                <p class="decision-reason">{{ item.reason }}</p>
                <p v-if="item.summaryPreview" class="decision-summary">{{ item.summaryPreview }}</p>
                <div class="decision-signals">
                  <div v-if="item.flagPreview.length">
                    <span>Flag</span>
                    <strong v-for="flag in item.flagPreview" :key="flag">{{ flag }}</strong>
                  </div>
                  <div v-if="item.accessPreview.length">
                    <span>访问点</span>
                    <strong v-for="access in item.accessPreview" :key="access">{{ access }}</strong>
                  </div>
                  <div v-if="item.problemPreview.length">
                    <span>阻塞</span>
                    <strong v-for="problem in item.problemPreview" :key="problem">{{ problem }}</strong>
                  </div>
                </div>
                <div v-if="item.visibleSteps.length" class="decision-steps">
                  <span v-for="step in item.visibleSteps" :key="step">{{ step }}</span>
                  <span v-if="item.hiddenSteps">+{{ item.hiddenSteps }}</span>
                </div>
                <p v-else class="note-empty">暂无下一步建议。</p>
              </div>
            </article>
          </section>

          <aside class="strategy-note">
            <div class="strategy-note-head">
              <div>
                <h2>复盘检查</h2>
                <p>{{ noteStats.activeUpdatedAt }}</p>
              </div>
              <span>Review</span>
            </div>
            <div class="strategy-note-metrics">
              <article>
                <span>检查项</span>
                <strong>{{ strategyChecklist.length }}</strong>
              </article>
              <article>
                <span>复盘块</span>
                <strong>{{ strategyReviewSections.length }}</strong>
              </article>
            </div>
            <div v-if="strategyChecklist.length || strategyReviewSections.length" class="strategy-note-body">
              <section v-if="strategyChecklist.length" class="strategy-note-section primary">
                <h3>目标完成情况</h3>
                <div class="strategy-note-status">
                  <div v-for="item in strategyChecklist" :key="item.target" class="strategy-note-row">
                    <strong>{{ item.target }}</strong>
                    <span>{{ item.status }}</span>
                    <small>{{ item.note }}</small>
                  </div>
                </div>
              </section>
              <section v-for="section in strategyReviewSections" :key="section.title" class="strategy-note-section">
                <h3>{{ section.title }}</h3>
                <ul v-if="section.items.length">
                  <li v-for="item in section.items" :key="item">{{ item }}</li>
                </ul>
                <template v-else>
                  <p v-for="paragraph in section.body" :key="paragraph">{{ paragraph }}</p>
                </template>
              </section>
            </div>
            <p v-else class="note-empty">暂无笔记内容。</p>
          </aside>
        </div>
      </section>

      <section v-else-if="active === 'teams'" class="teams-page">
        <div class="team-summary-board">
          <article v-for="item in store.teams.sharedBoard || []" :key="item.label">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>

        <div class="handoff-lane">
          <div v-for="handoff in store.teams.handoffs || []" :key="`${handoff.from}-${handoff.to}-${handoff.title}`" class="handoff-step" :class="handoff.status">
            <span>{{ handoff.from }}</span>
            <strong>{{ handoff.to }}</strong>
            <small>{{ handoff.title }}</small>
          </div>
        </div>

        <div class="team-card-grid">
          <article v-for="team in store.teams.teams" :key="team.id" class="team-card" :class="team.status">
            <div class="team-head">
              <div>
                <strong>{{ team.name }}</strong>
                <p>{{ team.focus }}</p>
              </div>
              <span>{{ team.status }}</span>
            </div>

            <div class="team-route">
              <span>接收</span>
              <strong>{{ (team.receivesFrom || []).join(" / ") || "入口目标" }}</strong>
              <span>交付</span>
              <strong>{{ (team.handsOffTo || []).join(" / ") || "最终报告" }}</strong>
            </div>

            <ul class="team-tasks">
              <li v-for="task in team.tasks" :key="task.id" :class="task.status">
                <div>
                  <strong>{{ task.title }}</strong>
                  <span>{{ task.status }} · {{ task.count }}</span>
                </div>
                <small>{{ task.evidence || "暂无证据" }}</small>
              </li>
            </ul>
            <div class="team-outputs">
              <span v-for="output in team.outputs" :key="output">{{ output }}</span>
            </div>
          </article>
        </div>
      </section>
    </main>
  </div>
</template>
