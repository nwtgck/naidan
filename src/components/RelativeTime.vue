<script setup lang="ts">
import { currentLocale, lazyStrings } from '@/strings';
import { ref, onMounted, onUnmounted, computed } from 'vue';

const props = defineProps<{
  timestamp: number,
  prefix?: string,
}>();

const now = ref(Date.now());
let timer: ReturnType<typeof setTimeout> | null = null;

const timeFormatter = computed(() => new Intl.DateTimeFormat(currentLocale.value, {
  month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
}));

const relativeTime = computed(() => {
  const diff = now.value - props.timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 5) return lazyStrings.RelativeTime__just_now();
  if (seconds < 60) return lazyStrings.RelativeTime__seconds_ago({ seconds });
  if (minutes < 60) return lazyStrings.RelativeTime__minutes_ago({ minutes });
  if (hours < 24) return lazyStrings.RelativeTime__hours_ago({ hours });
  if (days < 7) return lazyStrings.RelativeTime__days_ago({ days });

  return timeFormatter.value.format(new Date(props.timestamp));
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
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <span>{{ prefix }}{{ relativeTime }}</span>
</template>
