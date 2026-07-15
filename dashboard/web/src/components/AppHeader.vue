<script setup lang="ts">
import { navItems, type NavKey } from "../config/navigation";
import { useRuntimeStore } from "../stores/runtime";

defineProps<{
  active: NavKey;
}>();

const emit = defineEmits<{
  "go-home": [];
  "update:active": [value: NavKey];
}>();

const store = useRuntimeStore();
</script>

<template>
  <header class="app-header">
    <button class="brand brand-button" type="button" @click="emit('go-home')" aria-label="返回欢迎页">
      <strong>AegisFlow</strong>
    </button>
    <span class="key-status" :class="{ ready: store.runtimeConfig.hasApiKey }">
      {{ store.runtimeConfig.hasApiKey ? "Key 已配置" : "Key 未配置" }}
    </span>
    <a class="report-export" href="/api/report/export?format=pdf" download>
      导出 PDF
    </a>
    <nav class="top-nav" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="nav-item"
        :class="{ active: active === item.key }"
        @click="emit('update:active', item.key)"
      >
        {{ item.label }}
      </button>
    </nav>
  </header>
</template>
