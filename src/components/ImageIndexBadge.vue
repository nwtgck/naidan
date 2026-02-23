<script setup lang="ts">
defineProps<{
  index: number;
  total?: number;
}>();


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="px-1.5 py-0.5 bg-black/50 backdrop-blur-md rounded text-[9px] font-bold text-white shadow-sm border border-white/10">
    {{ index }}<template v-if="total !== undefined && total > 0"> / {{ total }}</template>
  </div>
</template>
