<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useRuntimeStore } from "../stores/runtime";

const emit = defineEmits<{
  navigate: [value: "overview"];
}>();

const store = useRuntimeStore();

const runForm = reactive({
  targetUrl: "http://47.238.225.21:18080/",
  flagsNeeded: 6,
  maxFlags: 6,
  maxLoops: 8,
  minLoops: 1,
  stopAfterStale: 2,
  proxyPort: 9999,
  model: "deepseek/deepseek-v4-flash",
  attachUrl: "http://localhost:4096",
  pattern: "",
  scopeMode: "entry-port",
  allowPrivatePivot: true,
  noAuto: false,
});

watch(
  () => store.runtimeConfig,
  (config) => {
    if (config.model) runForm.model = config.model;
    if (config.attachUrl) runForm.attachUrl = config.attachUrl;
  },
  { immediate: true },
);

const commandPreview = computed(() => {
  const args = [
    "node index.js",
    "--target", hostFromUrl(runForm.targetUrl),
    "--port", portFromUrl(runForm.targetUrl),
    "--flags", runForm.flagsNeeded,
    "--max-flags", runForm.maxFlags,
    "--max-loops", runForm.maxLoops,
    "--min-loops", runForm.minLoops,
    "--stop-after-stale", runForm.stopAfterStale,
    "--proxy-port", runForm.proxyPort,
    "--model", runForm.model,
  ];
  if (runForm.attachUrl) args.push("--attach", runForm.attachUrl);
  if (runForm.pattern) args.push("--pattern", runForm.pattern);
  if (runForm.scopeMode) args.push("--scope", runForm.scopeMode);
  if (!runForm.allowPrivatePivot) args.push("--no-private-pivot");
  if (runForm.noAuto) args.push("--no-auto");
  return args.join(" ");
});

async function startRun() {
  await store.startRun({ ...runForm });
  if (!store.actionError) emit("navigate", "overview");
}

function hostFromUrl(input: string) {
  try {
    const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
    return new URL(text).hostname || "?";
  } catch {
    return "?";
  }
}

function portFromUrl(input: string) {
  try {
    const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
    const url = new URL(text);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "?";
  }
}
</script>

<template>
  <section class="start-layout">
    <article class="panel launch-panel">
      <form class="launch-form" @submit.prevent="startRun">
        <label class="field field-full">
          <span>目标地址</span>
          <input v-model="runForm.targetUrl" placeholder="http://node5.anna.nssctf.cn:23341" />
        </label>
        <label class="field field-half">
          <span>公网边界</span>
          <select v-model="runForm.scopeMode">
            <option value="entry-port">仅当前入口端口</option>
            <option value="public-host">同公网主机端口</option>
            <option value="open">开放边界</option>
          </select>
        </label>
        <label class="check-field scope-check">
          <input v-model="runForm.allowPrivatePivot" type="checkbox" />
          <span>允许入口打通后的私网横向</span>
        </label>
        <label class="field field-half">
          <span>最低 flag 数</span>
          <input v-model.number="runForm.flagsNeeded" min="1" type="number" />
        </label>
        <label class="field field-half">
          <span>预估最大 flag 数</span>
          <input v-model.number="runForm.maxFlags" min="1" type="number" />
        </label>
        <label class="field field-half">
          <span>最大循环</span>
          <input v-model.number="runForm.maxLoops" min="1" type="number" />
        </label>
        <label class="field field-half">
          <span>最小循环</span>
          <input v-model.number="runForm.minLoops" min="1" type="number" />
        </label>
        <label class="field field-half">
          <span>停滞停止轮数</span>
          <input v-model.number="runForm.stopAfterStale" min="1" type="number" />
        </label>
        <label class="field field-half">
          <span>代理端口</span>
          <input v-model.number="runForm.proxyPort" min="1" max="65535" type="number" />
        </label>
        <label class="field field-full">
          <span>模型</span>
          <input v-model="runForm.model" placeholder="deepseek/deepseek-v4-flash" />
        </label>
        <label class="field field-half">
          <span>Attach URL</span>
          <input v-model="runForm.attachUrl" placeholder="http://localhost:4096" />
        </label>
        <label class="field field-full">
          <span>自定义 flag 正则</span>
          <input v-model="runForm.pattern" placeholder="留空使用默认规则" />
        </label>
        <label class="check-field">
          <input v-model="runForm.noAuto" type="checkbox" />
          <span>关闭自动批准</span>
        </label>

        <div class="form-actions full">
          <button class="primary-button" type="submit" :disabled="store.run.running">启动任务</button>
          <button class="secondary-button" type="button" :disabled="!store.run.running" @click="store.stopRun()">停止任务</button>
        </div>
      </form>

      <p v-if="store.actionError" class="form-message error">{{ store.actionError }}</p>
      <p v-if="store.actionMessage" class="form-message ok">{{ store.actionMessage }}</p>
      <pre class="command-preview">{{ commandPreview }}</pre>
    </article>
  </section>
</template>
