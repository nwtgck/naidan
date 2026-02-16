<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  remainingCount?: number;
  totalCount?: number;
  currentStep?: number;
  totalSteps?: number;
}>();

const currentNumber = computed(() => {
  if (props.totalCount === undefined || props.remainingCount === undefined) return undefined;
  return Math.min(props.totalCount, Math.max(1, props.totalCount - props.remainingCount + 1));
});

const stepProgress = computed(() => {
  if (props.currentStep === undefined || props.totalSteps === undefined || props.totalSteps === 0) return undefined;
  return Math.round((props.currentStep / props.totalSteps) * 100);
});

defineExpose({
  __testOnly: {
    currentNumber,
    stepProgress
  }
});
</script>

<template>
  <div class="relative w-full max-w-[400px] aspect-square rounded-3xl overflow-hidden flex items-center justify-center group/conjure" data-testid="image-conjuring-loader">
    <!-- Ambient Glow & Grid -->
    <div class="absolute inset-0 pointer-events-none">
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.15)_0%,transparent_70%)]"></div>
      <div class="absolute inset-0 opacity-[0.05] dark:opacity-[0.1]" style="background-image: linear-gradient(rgba(59,130,246,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.3) 1px, transparent 1px); background-size: 48px 48px; mask-image: radial-gradient(circle at center, black, transparent 80%);"></div>
    </div>

    <!-- Magical Particles -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div v-for="i in 30" :key="i" class="magic-particle"
           :style="`
          --d: ${Math.random() * 360}deg;
          --t: ${3 + Math.random() * 2}s;
          --del: -${Math.random() * 5}s;
          --size: ${1.2 + Math.random() * 3}px;
          --dist: ${100 + Math.random() * 80}px;
          --color: ${i % 6 === 0 ? '#fbbf24' : '#3b82f6'}
        `">
      </div>
    </div>

    <!-- Central Core -->
    <div class="relative flex flex-col items-center gap-6">
      <!-- Ambient glow -->
      <div class="absolute w-40 h-40 bg-blue-500/15 blur-[50px] animate-pulse"></div>

      <div class="relative z-10 flex flex-col items-center gap-4">
        <!-- Status Header -->
        <div class="flex flex-col items-center gap-1">
          <span class="text-[11px] font-bold text-blue-500/80 dark:text-blue-400/80 drop-shadow-[0_0_8px_rgba(96,165,250,0.4)] animate-subtle-pulse whitespace-nowrap">
            {{ totalCount && totalCount > 1 ? 'Generating images...' : 'Generating image...' }}
          </span>

          <!-- Step Display -->
          <div v-if="currentStep !== undefined" class="flex flex-col items-center -gap-1" data-testid="step-display">
            <div class="flex items-baseline gap-1">
              <span class="text-3xl font-mono font-bold text-blue-500 dark:text-blue-400 tabular-nums">
                {{ currentStep }}
              </span>
              <span class="text-xl font-bold text-blue-500/60 dark:text-blue-400/60">/ {{ totalSteps }}</span>
            </div>
            <span class="text-[10px] font-mono font-bold text-blue-500/40 dark:text-blue-400/40 uppercase tracking-widest">steps</span>
          </div>
          <div v-else class="h-14 flex items-center justify-center">
            <div class="w-1.5 h-1.5 bg-blue-500/60 rounded-full animate-ping"></div>
          </div>
        </div>

        <!-- Progress bar for steps -->
        <div v-if="totalSteps" class="w-32 h-1 bg-blue-500/10 dark:bg-blue-400/5 rounded-full overflow-hidden border border-blue-500/10">
          <div
            :key="currentNumber"
            class="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500 ease-out relative animate-bar-reset"
            :style="{ width: `${stepProgress}%` }"
            data-testid="step-progress-bar"
          >
            <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
          </div>
        </div>

        <!-- Image Count Indicators -->
        <div v-if="totalCount && totalCount > 1" class="flex flex-col items-center gap-2 mt-1" data-testid="image-count-indicators">
          <div class="flex gap-2">
            <div
              v-for="i in totalCount"
              :key="i"
              class="w-1.5 h-1.5 rounded-full transition-all duration-500"
              :class="[
                i < (currentNumber || 0) ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' :
                i === (currentNumber || 0) ? 'bg-blue-400 scale-125 ring-2 ring-blue-500/20 animate-pulse' :
                'bg-gray-200 dark:bg-white/10'
              ]"
            ></div>
          </div>
          <span class="text-[10px] font-mono font-bold text-blue-400/60" data-testid="image-count-label">
            Image {{ currentNumber }} / {{ totalCount }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes subtle-pulse {
  0%, 100% { opacity: 0.8; transform: scale(0.99); }
  50% { opacity: 1; transform: scale(1); }
}
.animate-subtle-pulse {
  animation: subtle-pulse 3s ease-in-out infinite;
}

@keyframes bar-reset {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
.animate-bar-reset {
  animation: bar-reset 0.4s ease-out;
}

@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.animate-shimmer {
  animation: shimmer 2s infinite linear;
}

.magic-particle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--size);
  height: var(--size);
  background: var(--color);
  border-radius: 50%;
  box-shadow: 0 0 calc(var(--size) * 3) var(--color);
  opacity: 0;
  animation: particle-expansion var(--t) ease-out infinite;
  animation-delay: var(--del);
}

@keyframes particle-expansion {
  0% {
    transform: rotate(var(--d)) translateX(0) scale(0);
    opacity: 0;
  }
  15% {
    opacity: 0.8;
    transform: rotate(var(--d)) translateX(30px) scale(1.2);
  }
  100% {
    transform: rotate(var(--d)) translateX(var(--dist)) scale(0.2);
    opacity: 0;
  }
}
</style>
