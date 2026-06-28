<script setup lang="ts">
const props = defineProps<{
  error: unknown,
}>();

const message = (() => {
  if (props.error instanceof Error) {
    return `${props.error.name}: ${props.error.message}`;
  }
  return String(props.error);
})();


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  }
});
</script>

<template>
  <main class="min-h-dvh p-6 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
    <section
      role="alert"
      data-testid="startup-error"
      class="max-w-3xl rounded-xl border border-red-600 bg-red-50 dark:bg-red-950/40 p-5 text-red-900 dark:text-red-200 whitespace-pre-wrap break-words"
    >
      <strong class="block mb-2">Naidan failed to start.</strong>
      <div>{{ message }}</div>
    </section>
  </main>
</template>
