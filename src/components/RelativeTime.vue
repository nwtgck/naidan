<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';

const props = defineProps<{
  timestamp: number;
  prefix?: string;
}>();

const now = ref(Date.now());
let timer: ReturnType<typeof setTimeout> | null = null;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit'
});

const relativeTime = computed(() => {
  const diff = now.value - props.timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return timeFormatter.format(new Date(props.timestamp));
});

const scheduleUpdate = () => {
  if (timer) clearTimeout(timer);

  const diff = Date.now() - props.timestamp;
  let nextDelay = 60000; // Default 1 minute

  if (diff < 60000) nextDelay = 10000; // 10 seconds if less than a minute
  else if (diff < 3600000) nextDelay = 30000; // 30 seconds if less than an hour

  timer = setTimeout(() => {
    now.value = Date.now();
    scheduleUpdate();
  }, nextDelay);
};

onMounted(() => {
  scheduleUpdate();
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <span>{{ prefix }}{{ relativeTime }}</span>
</template>
