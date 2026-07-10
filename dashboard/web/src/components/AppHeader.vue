<script setup lang="ts">
import { navItems, type NavKey } from "../config/navigation";
import { useRuntimeStore } from "../stores/runtime";

defineProps<{
  active: NavKey;
}>();

const emit = defineEmits<{
  "update:active": [value: NavKey];
}>();

const store = useRuntimeStore();

async function selectArchive(event: Event) {
  await store.selectArchive((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark">SA</span>
      <div>
        <strong>Smart Attack</strong>
        <small>ThinkPHP 靶场</small>
      </div>
    </div>
    <label class="archive-picker">
      <span>演示数据</span>
      <select :value="store.archive.selected" @change="selectArchive">
        <option v-for="item in store.archive.items" :key="item.id" :value="item.id">
          {{ item.label }}
        </option>
      </select>
    </label>
    <span class="key-status" :class="{ ready: store.runtimeConfig.hasApiKey }">
      {{ store.runtimeConfig.hasApiKey ? "Key 已配置" : "Key 未配置" }}
    </span>
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
