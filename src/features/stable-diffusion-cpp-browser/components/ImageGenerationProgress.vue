<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import type { Progress } from '@/features/stable-diffusion-cpp-browser/types';

const props = defineProps<{
  busy: boolean, supported: boolean, active: boolean, stopping: boolean, progress: Progress | undefined,
  width: number, height: number, image: { url: string, width: number, height: number } | undefined,
}>();
const visible = computed(() => props.supported && props.busy);
const running = computed(() => visible.value && props.active && !props.stopping);
const elapsedSeconds = ref(0);
let began = 0;
watch(visible, value => {
  began = value ? performance.now() : 0;
  elapsedSeconds.value = 0;
}, { immediate: true, flush: 'sync' });
watch(running, (value, _previous, onCleanup) => {
  if (!value) return;
  const tick = () => {
    elapsedSeconds.value = Math.floor((performance.now() - began) / 1000);
  };
  tick();
  const timer = setInterval(tick, 1000);
  onCleanup(() => clearInterval(timer));
}, { immediate: true, flush: 'sync' });
// Native units describe the current phase, never overall generation completion.
// Model loading reports tensor indices; keep those implementation counts out of the UI.
const units = computed(() => props.progress && props.progress.steps > 0
  ? { current: Math.min(props.progress.step, props.progress.steps), total: props.progress.steps }
  : undefined);
const phasePercent = computed(() => units.value ? Math.floor(units.value.current / units.value.total * 100) : undefined);
const sampling = computed(() => props.progress?.phase === 'sampling');
// The next active step is inferred from completed-step callbacks, not a step-start event.
const displayedStep = computed(() => units.value
  ? Math.min(units.value.current + (props.stopping ? 0 : 1), units.value.total)
  : undefined);
const samplingStatus = computed(() => {
  if (!sampling.value || !units.value || displayedStep.value === undefined) return undefined;
  if (props.stopping || units.value.current === units.value.total) {
    return lazyStrings.ImageGenerationProgress__steps_completed({ current: units.value.current, total: units.value.total });
  }
  return lazyStrings.ImageGenerationProgress__processing_step({ current: displayedStep.value, total: units.value.total });
});
const phaseLabel = computed(() => {
  if (props.stopping) return lazyStrings.stableDiffusionCppBrowser__stopping_retained();
  if (!props.progress) return lazyStrings.llamaCppBrowserDownloads__waiting();
  switch (props.progress.phase) {
  case 'runtime': return lazyStrings.stableDiffusionCppBrowser__loading_runtime();
  case 'model': return lazyStrings.stableDiffusionCppBrowser__loading_model();
  case 'sampling': return units.value ? samplingStatus.value : lazyStrings.stableDiffusionCppBrowser__sampling();
  case 'decoding': return lazyStrings.stableDiffusionCppBrowser__decoding_image();
  case 'encoding': return lazyStrings.stableDiffusionCppBrowser__encoding();
  default: { const exhaustive: never = props.progress.phase; throw new Error(String(exhaustive)); }
  }
});
// Copy the Ollama loader's visual language without coupling the generation paths.
const particles = Array.from({ length: 30 }, (_, index) => ({
  '--direction': `${index * 137.5}deg`, '--duration': `${3 + index % 3}s`,
  '--delay': `${-index * 0.37}s`, '--distance': `${100 + index % 5 * 16}px`,
  '--size': `${1.2 + index % 4}px`, '--color': index % 6 === 0 ? '#fbbf24' : '#3b82f6',
}));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="visible" data-testid="image-generation-progress" :data-running="running && !image" class="generation-progress" tw-class="w-full">
    <div :style="{ aspectRatio: `${width} / ${height}`, maxWidth: `${65 * width / height}vh` }" data-testid="image-generation-canvas" tw-class="relative w-full mx-auto overflow-hidden rounded-2xl flex items-center justify-center bg-gray-50/50 dark:bg-gray-900/30">
      <img v-if="image" :src="image.url" :width="image.width" :height="image.height" :style="{ maxWidth: `min(100%, ${image.width}px)` }" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" data-testid="image-generation-current-preview" tw-class="max-h-full object-contain" />
      <template v-else>
        <div aria-hidden="true" tw-class="absolute inset-0 pointer-events-none">
          <div tw-class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.15)_0%,transparent_70%)]"></div>
          <div tw-class="absolute inset-0 opacity-[0.05] dark:opacity-[0.1]" style="background-image: linear-gradient(rgba(59,130,246,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.3) 1px, transparent 1px); background-size: 48px 48px; mask-image: radial-gradient(circle at center, black, transparent 80%);"></div>
          <div v-for="(particle, index) in particles" :key="index" :style="particle" class="generation-particle"></div>
        </div>
        <div tw-class="relative flex flex-col items-center gap-6 py-6">
          <div aria-hidden="true" class="generation-glow" tw-class="absolute w-40 h-40 bg-blue-500/15 blur-[50px]"></div>
          <div tw-class="relative z-10 flex flex-col items-center gap-4">
            <span data-testid="image-generation-heading" class="generation-glow" tw-class="text-[11px] font-bold text-blue-500/80 dark:text-blue-400/80 drop-shadow-[0_0_8px_rgba(96,165,250,0.4)]">{{ phaseLabel }}</span>
            <div v-if="units" data-testid="image-generation-units" tw-class="flex flex-col items-center gap-1 text-blue-500 dark:text-blue-400 tabular-nums">
              <div v-if="sampling" tw-class="flex items-baseline gap-1"><span tw-class="text-3xl font-mono font-bold">{{ displayedStep }}</span><span tw-class="text-xl font-bold text-blue-500/60 dark:text-blue-400/60">/ {{ units.total }}</span></div>
              <span v-else tw-class="text-3xl font-mono font-bold">{{ phasePercent }}%</span>
              <span v-if="sampling && stopping" tw-class="text-[10px] font-mono font-bold text-blue-500/60 dark:text-blue-400/60">{{ samplingStatus }}</span>
            </div>
            <div v-else tw-class="h-14 flex items-center justify-center"><div class="generation-glow" tw-class="w-1.5 h-1.5 bg-blue-500/60 rounded-full"></div></div>
            <div v-if="units" role="progressbar" :aria-label="sampling ? lazyStrings.ImageGenerationProgress__steps_completed({ current: units.current, total: units.total }) : phaseLabel" :aria-valuenow="sampling ? units.current : phasePercent" :aria-valuemin="0" :aria-valuemax="sampling ? units.total : 100" tw-class="w-32 h-1 overflow-hidden rounded-full bg-blue-500/10 border border-blue-500/10">
              <div :style="{ width: `${units.current / units.total * 100}%` }" tw-class="relative h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400">
                <div aria-hidden="true" class="generation-shimmer" tw-class="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
              </div>
            </div>
            <div v-else role="progressbar" :aria-label="phaseLabel" data-testid="image-generation-indeterminate" tw-class="w-32 h-1 overflow-hidden rounded-full bg-blue-500/10 border border-blue-500/10">
              <div aria-hidden="true" class="generation-travelling" tw-class="w-1/3 h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400"></div>
            </div>
          </div>
        </div>
      </template>
    </div>
    <div tw-class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
      <p role="status" aria-live="polite" data-testid="image-generation-phase">{{ phaseLabel }}<template v-if="sampling && stopping && units"> · {{ samplingStatus }}</template><template v-else-if="image && units && !sampling"> · {{ phasePercent }}%</template></p>
      <span data-testid="image-generation-elapsed" tw-class="tabular-nums">{{ lazyStrings.stableDiffusionCppBrowser__generation_time() }} {{ elapsedSeconds }} s</span>
    </div>
  </div>
</template>

<style scoped>
.generation-particle {
  position: absolute; top: 50%; left: 50%; width: var(--size); height: var(--size);
  background: var(--color); border-radius: 50%; box-shadow: 0 0 calc(var(--size) * 3) var(--color);
  opacity: 0; animation: particle-expansion var(--duration) ease-out infinite; animation-delay: var(--delay);
}
.generation-glow { animation: glow 3s ease-in-out infinite; }
.generation-shimmer { animation: shimmer 2s linear infinite; }
.generation-travelling { transform: translateX(100%); animation: travelling 1.6s ease-in-out infinite alternate; }
.generation-progress[data-running="false"] * { animation: none; }
@keyframes particle-expansion {
  0% { transform: rotate(var(--direction)) translateX(0) scale(0); opacity: 0; }
  15% { opacity: 0.8; transform: rotate(var(--direction)) translateX(30px) scale(1.2); }
  100% { transform: rotate(var(--direction)) translateX(var(--distance)) scale(0.2); opacity: 0; }
}
@keyframes glow { 0%, 100% { opacity: 0.8; transform: scale(0.99); } 50% { opacity: 1; transform: scale(1); } }
@keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
@keyframes travelling { from { transform: translateX(0); } to { transform: translateX(200%); } }
@media (prefers-reduced-motion: reduce) {
  .generation-progress * { animation: none; }
}
</style>
