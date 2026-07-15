<script setup lang="ts">
const emit = defineEmits<{
  enter: [];
}>();
</script>

<template>
  <main class="landing-page" aria-labelledby="landing-title">
    <div class="aurora-layer landing-aurora" aria-hidden="true"></div>

    <section class="landing-content">
      <h1 id="landing-title">
        <button class="landing-brand" type="button" @click="emit('enter')">
          AegisFlow
        </button>
      </h1>
    </section>
  </main>
</template>
