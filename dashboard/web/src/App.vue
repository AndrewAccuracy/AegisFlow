<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AppHeader from "./components/AppHeader.vue";
import type { NavKey } from "./config/navigation";
import OverviewPage from "./pages/OverviewPage.vue";
import StartPage from "./pages/StartPage.vue";
import TopologyPage from "./pages/TopologyPage.vue";
import { useRuntimeStore } from "./stores/runtime";

const store = useRuntimeStore();
const initialTab = window.location.hash.slice(1) as NavKey;
const active = ref<NavKey>(initialTab || "start");
const renderedNote = computed(() => renderMarkdown(store.activeNote?.content || ""));

function setActive(value: NavKey) {
  active.value = value;
  window.history.replaceState(null, "", `#${value}`);
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

onMounted(async () => {
  await store.refreshAll();
  store.connectEvents();
  window.setInterval(() => store.refreshAll(), 3000);
});
</script>

<template>
  <div class="shell">
    <AppHeader :active="active" @update:active="setActive" />

    <main class="content">
      <StartPage v-if="active === 'start'" @navigate="setActive" />
      <OverviewPage v-else-if="active === 'overview'" />
      <TopologyPage v-else-if="active === 'assets'" />

      <section v-else-if="active === 'timeline'" class="timeline">
        <article v-for="item in store.iterations" :key="item.iter" class="timeline-item">
          <div class="timeline-badge">{{ item.iter }}</div>
          <div class="panel">
            <h2>{{ item.position || `第 ${item.iter} 轮` }}</h2>
            <p>{{ item.summary }}</p>
            <small>{{ item.time }}</small>
          </div>
        </article>
      </section>

      <section v-else-if="active === 'findings'" class="panel">
        <table>
          <thead><tr><th>轮次</th><th>Hosts</th><th>Services</th><th>Credentials</th><th>Intel</th></tr></thead>
          <tbody>
            <tr v-for="item in store.iterations" :key="item.iter">
              <td>{{ item.iter }}</td>
              <td>{{ (item.hosts || []).join(', ') || '-' }}</td>
              <td>{{ (item.services || []).map(s => `${s.host || '?'}:${s.port || '?'} ${s.name || ''}`).join('; ') || '-' }}</td>
              <td>{{ (item.credentials || []).map(c => `${c.username || '?'}@${c.host || c.service || '?'}`).join('; ') || '-' }}</td>
              <td>{{ (item.intel || []).join('; ') || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-else-if="active === 'tools'" class="panel">
        <table>
          <thead><tr><th>轮次</th><th>工具</th><th>命令</th><th>目的</th><th>影响</th></tr></thead>
          <tbody>
            <template v-for="item in store.iterations" :key="item.iter">
              <tr v-for="call in item.toolCalls || []" :key="`${item.iter}-${call.command}`">
                <td>{{ item.iter }}</td><td>{{ call.tool }}</td><td><code>{{ call.command }}</code></td><td>{{ call.purpose }}</td><td>{{ call.impact }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>

      <section v-else-if="active === 'flags'" class="panel">
        <ul class="flag-list">
          <li v-for="flag in store.flags.flags || []" :key="flag.value">
            <code>{{ flag.value }}</code>
            <div class="flag-meta">
              <span>来源：{{ flag.source || "待确认" }}</span>
              <span>方法：{{ flag.evidence?.method || "待确认" }}</span>
              <span>轮次：{{ flag.evidence?.iter ?? "-" }}</span>
            </div>
            <p v-if="flag.evidence?.summary">{{ flag.evidence.summary }}</p>
            <pre v-if="flag.evidence?.command">{{ flag.evidence.command }}</pre>
          </li>
        </ul>
      </section>

      <section v-else-if="active === 'notes'" class="notes-layout">
        <aside class="panel note-list-panel">
          <button
            v-for="note in store.notes"
            :key="note.name"
            class="note-item"
            :class="{ active: store.activeNote?.name === note.name }"
            @click="store.loadNote(note.name)"
          >
            <strong>{{ note.name }}</strong>
            <span>{{ Math.ceil(note.size / 1024) }} KB · {{ new Date(note.updatedAt).toLocaleString() }}</span>
          </button>
        </aside>
        <article class="panel note-reader">
          <div class="section-title compact">
            <div>
              <h2>{{ store.activeNote?.name || "请选择笔记" }}</h2>
              <p>{{ store.activeNote?.updatedAt ? new Date(store.activeNote.updatedAt).toLocaleString() : "artifacts/notes" }}</p>
            </div>
          </div>
          <div v-if="store.activeNote?.content" class="markdown-body" v-html="renderedNote"></div>
          <p v-else>暂无笔记内容。</p>
        </article>
      </section>

      <section v-else-if="active === 'strategy'" class="panel">
        <article v-for="item in store.iterations" :key="item.iter" class="decision">
          <h3>第 {{ item.iter }} 轮</h3>
          <p><strong>奖励：</strong>{{ item.rewardEvaluation?.level || "-" }} {{ item.rewardEvaluation?.reason || "" }}</p>
          <ul>
            <li v-for="step in item.nextSteps || []" :key="step">{{ step }}</li>
          </ul>
        </article>
      </section>

      <section v-else-if="active === 'teams'" class="panel">
        <div class="shared-board team-summary">
          <article v-for="item in store.teams.sharedBoard || []" :key="item.label">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>

        <div class="handoff-strip">
          <div v-for="handoff in store.teams.handoffs || []" :key="`${handoff.from}-${handoff.to}-${handoff.title}`" class="handoff-step" :class="handoff.status">
            <span>{{ handoff.from }}</span>
            <strong>{{ handoff.to }}</strong>
            <small>{{ handoff.title }}</small>
          </div>
        </div>

        <div class="team-list">
          <article v-for="team in store.teams.teams" :key="team.id" class="team-row" :class="team.status">
            <div class="team-head">
              <div>
                <strong>{{ team.name }}</strong>
                <p>{{ team.focus }}</p>
              </div>
              <span>{{ team.status }}</span>
            </div>

            <div class="team-route">
              <span>接收：{{ (team.receivesFrom || []).join(" / ") || "入口目标" }}</span>
              <span>交付：{{ (team.handsOffTo || []).join(" / ") || "最终报告" }}</span>
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
