<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CpuIcon, FileIcon, FolderOpenIcon, HardDriveIcon, ListIcon, SearchIcon, ServerOffIcon, ShieldCheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { modelSuggestions, preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { browserModelShowcaseIds, browserModelSuggestionSelection, type ModelDiscoveryTab, type BrowserModelLocalInput, type BrowserModelSelection } from './browser-model-presentation';
import LanguageSelector from './LanguageSelector.vue';
import Logo from './Logo.vue';
import WelcomeScreenFrame from './layout/WelcomeScreenFrame.vue';

const props = defineProps<{
  interaction: 'blocked' | 'ready',
  selection: BrowserModelSelection,
  startStatus: 'idle' | 'starting',
  startError: string | undefined,
}>();
const emit = defineEmits<{
  select: [selection: BrowserModelSelection],
  start: [],
  'open-discovery': [request: { tab: ModelDiscoveryTab }],
  'local-input': [input: BrowserModelLocalInput],
}>();
const disabled = computed(() => props.interaction !== 'ready' || props.startStatus === 'starting');
const models = browserModelShowcaseIds.flatMap(id => {
  const suggestion = modelSuggestions.find(model => model.id === id);
  return suggestion ? [suggestion] : [];
});
const selected = computed(() => browserModelSuggestionSelection({ selection: props.selection }));
const selectedIndex = computed(() => models.findIndex(model => model.id === selected.value?.suggestion.id));
type ModelCardPosition = 'selected' | 'previous' | 'next' | 'hidden';
const modelCards = computed(() => {
  const current = selected.value;
  const candidates = current && selectedIndex.value < 0 ? [...models, current.suggestion] : models;
  const currentIndex = candidates.findIndex(model => model.id === selected.value?.suggestion.id);
  const half = Math.floor(candidates.length / 2);
  return candidates.map((model, index) => {
    const distance = (index - currentIndex + candidates.length + half) % candidates.length - half;
    const position: ModelCardPosition = distance === 0 ? 'selected' : distance === -1 ? 'previous' : distance === 1 ? 'next' : 'hidden';
    const hint = current && model.id === current.suggestion.id ? current.quantization : preferredQuantizationHint({ suggestion: model });
    return { model, hint, position, offset: Math.max(-2, Math.min(2, distance)) };
  });
});
const discoveryHint = ref<'hidden' | 'visible'>('hidden');
const swipeStart = ref<{ pointerId: number, x: number, y: number }>();
const swipeOffset = ref(0);
const fileInput = ref<HTMLInputElement>();
const directoryInput = ref<HTMLInputElement>();
let suppressStartUntil = 0;

function selectModel({ index }: { index: number }): void {
  if (disabled.value || !models.length) {
    return;
  }
  const model = models[(index + models.length) % models.length];
  if (!model) {
    return;
  }
  emit('select', { suggestionId: model.id, quantizationId: preferredQuantizationHint({ suggestion: model }).id });
  discoveryHint.value = 'visible';
}

function moveModel({ step }: { step: -1 | 1 }): void {
  selectModel({ index: selectedIndex.value + step });
}

function activateCard({ position }: { position: ModelCardPosition }): void {
  if (disabled.value || Date.now() < suppressStartUntil) {
    return;
  }
  switch (position) {
  case 'selected': emit('start');
    return;
  case 'previous': moveModel({ step: -1 });
    return;
  case 'next': moveModel({ step: 1 });
    return;
  case 'hidden': return;
  default: {
    const exhaustive: never = position;
    throw new Error(String(exhaustive));
  }
  }
}

function beginSwipe({ event }: { event: PointerEvent }): void {
  if (disabled.value || event.button !== 0) {
    return;
  }
  swipeStart.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
}

function cancelSwipe(): void {
  swipeStart.value = undefined;
  swipeOffset.value = 0;
}

function moveSwipe({ event }: { event: PointerEvent }): void {
  const start = swipeStart.value;
  if (!start || event.pointerId !== start.pointerId) {
    return;
  }
  const distance = event.clientX - start.x;
  if (Math.abs(event.clientY - start.y) > Math.abs(distance) && Math.abs(event.clientY - start.y) > 10) {
    cancelSwipe();
    return;
  }
  swipeOffset.value = distance / (1 + Math.abs(distance) / 240);
  if (Math.abs(distance) > 6 && event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
}

function finishSwipe({ event }: { event: PointerEvent }): void {
  const start = swipeStart.value;
  if (!start || event.pointerId !== start.pointerId) {
    return;
  }
  const distance = event.clientX - start.x;
  cancelSwipe();
  // A browser click following a swipe must not start the newly centered model.
  if (Math.abs(distance) > 8) {
    suppressStartUntil = Date.now() + 400;
  }
  if (Math.abs(distance) >= 40) {
    moveModel({ step: distance < 0 ? 1 : -1 });
  }
}

function pickFiles({ event, selection }: { event: Event, selection: 'files' | 'directory' }): void {
  if (disabled.value || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(event.target.files ?? []);
  event.target.value = '';
  if (!files.length) {
    return;
  }
  const controller = new AbortController();
  const directories = Promise.resolve().then(() => localModelDirectoriesFromFiles({ files, selection }));
  emit('local-input', { directories, controller });
}

function modelSize({ bytes }: { bytes: number }): string | undefined {
  return lazyStrings.llamaCppBrowser__approximately_gb({ size: (bytes / 1e9).toFixed(1) });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <WelcomeScreenFrame placement="contained" :inert="interaction === 'blocked' || undefined" data-testid="browser-model-welcome">
    <template #default>
      <div tw-class="absolute right-4 top-4 z-20 pointer-events-auto sm:right-6 sm:top-6"><LanguageSelector /></div>
      <section tw-class="pointer-events-auto w-full max-w-3xl mx-auto space-y-4">
        <div class="onboarding-intro" tw-class="mx-auto max-w-2xl space-y-2 [container-type:inline-size]">
          <div class="onboarding-brand" data-testid="onboarding-brand" tw-class="flex items-center justify-center gap-2.5">
            <div tw-class="relative isolate"><span aria-hidden="true" tw-class="pointer-events-none absolute -inset-2 -z-10 rounded-full bg-blue-400/20 blur-xl dark:bg-blue-400/15" /><Logo :size="32" /></div>
            <span tw-class="text-[18px] font-semibold leading-none tracking-tight text-gray-600 dark:text-gray-300">Naidan</span>
          </div>
          <h2 data-testid="browser-model-heading" tw-class="text-[clamp(24px,6.5cqw,44px)] font-extrabold leading-[1.15] tracking-[-0.035em] text-gray-800 dark:text-gray-100">{{ lazyStrings.BrowserModelWelcome__run_ai_in_your_web_browser() }}</h2>
          <div tw-class="mx-auto flex w-fit max-w-full flex-col items-start gap-y-2 py-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-400 sm:w-full sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-4">
            <span tw-class="inline-flex items-center gap-1.5"><ServerOffIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__no_inference_server_required() }}</span>
            <span tw-class="inline-flex items-center gap-1.5"><ShieldCheckIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__prompts_stay_on_your_device() }}</span>
            <span tw-class="inline-flex items-center gap-4"><span tw-class="inline-flex items-center gap-1.5"><FileIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__gguf_support() }}</span><span tw-class="inline-flex items-center gap-1.5"><CheckIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__no_installation_required() }}</span></span>
          </div>
        </div>
        <div role="group" :aria-label="lazyStrings.BrowserModelWelcome__choose_the_model_to_use()" tw-class="mx-auto w-full text-left space-y-2">
          <div tw-class="mx-auto flex w-full max-w-md items-center justify-between gap-3">
            <div role="group" :aria-label="lazyStrings.BrowserModelWelcome__browse_models()" tw-class="flex shrink-0 items-center gap-1">
              <button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__previous_model()" data-testid="previous-model" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="moveModel({ step: -1 })"><ChevronLeftIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
              <span tw-class="min-w-9 text-center text-[12px] tabular-nums text-gray-400 dark:text-gray-500">{{ selectedIndex < 0 ? lazyStrings.BrowserModelWelcome__selected_model() : `${selectedIndex + 1} / ${models.length}` }}</span>
              <button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__next_model()" data-testid="next-model" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="moveModel({ step: 1 })"><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            </div>
            <button type="button" :disabled="disabled" data-testid="open-model-list" aria-haspopup="dialog" tw-class="group inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100/80 dark:hover:bg-gray-800/70 hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50" @click="emit('open-discovery', { tab: 'candidates' })"><ListIcon aria-hidden="true" tw-class="h-4 w-4 text-gray-500 dark:text-gray-400" />{{ lazyStrings.BrowserModelWelcome__choose_a_model() }}<ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
          </div>
          <p v-if="selected" role="status" tw-class="sr-only">{{ selected.suggestion.name }} {{ modelSize({ bytes: selected.quantization.approximateModelBytes }) }}</p>
          <div class="model-stage" tw-class="relative isolate">
            <div class="model-deck" :class="{ 'model-deck-dragging': swipeStart !== undefined }" :style="{ '--model-drag': `${swipeOffset}px` }" data-testid="model-swipe" tw-class="relative touch-pan-y select-none" @pointerdown="beginSwipe({ event: $event })" @pointermove="moveSwipe({ event: $event })" @pointerup="finishSwipe({ event: $event })" @pointercancel="cancelSwipe" @lostpointercapture="cancelSwipe" @keydown.left.prevent="moveModel({ step: -1 })" @keydown.right.prevent="moveModel({ step: 1 })">
              <button v-for="card in modelCards" :key="card.model.id" type="button" class="model-deck-card" :class="{ 'model-deck-card-selected': card.position === 'selected', 'model-deck-card-previous': card.position === 'previous', 'model-deck-card-next': card.position === 'next', 'model-deck-card-hidden': card.position === 'hidden' }" :style="{ '--model-offset': card.offset }" :data-testid="card.position === 'selected' ? 'start-model' : card.position === 'hidden' ? undefined : `peek-${card.position}`" :aria-label="card.position === 'selected' ? lazyStrings.BrowserModelWelcome__start_with_model({ name: card.model.name }) : lazyStrings.BrowserModelWelcome__select_model({ name: card.model.name })" :aria-hidden="card.position === 'hidden' ? true : undefined" :aria-busy="card.position === 'selected' && startStatus === 'starting'" :disabled="disabled || card.position === 'hidden'" :tabindex="card.position === 'hidden' ? -1 : 0" tw-class="group overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-left hover:border-blue-400 dark:hover:border-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-default" @click="activateCard({ position: card.position })">
                <div class="model-deck-preview" aria-hidden="true" tw-class="absolute inset-x-3 top-4 bottom-10 flex flex-col justify-center gap-2"><p tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ card.model.developer }}</p><p tw-class="whitespace-nowrap text-[20px] sm:text-[22px] font-bold leading-tight tracking-tight text-gray-600 dark:text-gray-300">{{ card.model.name }}</p></div>
                <span class="model-deck-preview" aria-hidden="true" tw-class="absolute inset-x-3 bottom-4 flex items-center justify-center gap-1 text-[11px] text-gray-400 dark:text-gray-500"><ArrowRightIcon v-if="card.position === 'previous'" tw-class="h-3 w-3" />{{ lazyStrings.BrowserModelWelcome__select() }}<ArrowLeftIcon v-if="card.position === 'next'" tw-class="h-3 w-3" /></span>
                <div class="model-deck-main" aria-hidden="true" tw-class="absolute inset-x-4 top-2 bottom-12 flex flex-col justify-center gap-3">
                  <div tw-class="flex items-center gap-3"><div class="model-cpu-accent" tw-class="hidden shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 text-gray-400 dark:text-gray-500 group-hover:border-sky-200/80 dark:group-hover:border-sky-400/25 group-hover:bg-sky-50 dark:group-hover:bg-sky-400/10 group-hover:text-sky-600 dark:group-hover:text-sky-300 group-focus-visible:border-sky-200/80 dark:group-focus-visible:border-sky-400/25 group-focus-visible:bg-sky-50 dark:group-focus-visible:bg-sky-400/10 group-focus-visible:text-sky-600 dark:group-focus-visible:text-sky-300 sm:block"><CpuIcon tw-class="w-5 h-5" /></div><div tw-class="min-w-0"><p tw-class="text-[12px] text-gray-500 dark:text-gray-400">{{ card.model.developer }}</p><h3 tw-class="text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight leading-snug [overflow-wrap:anywhere]">{{ card.model.name }}</h3></div></div>
                  <div tw-class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray-600 dark:text-gray-400"><span tw-class="inline-flex items-center gap-1"><HardDriveIcon tw-class="w-3.5 h-3.5" />{{ modelSize({ bytes: card.hint.approximateModelBytes }) }}</span><span>{{ lazyStrings.llamaCppBrowser__memory_estimate_gib({ memory: String(card.hint.suggestedMemoryGiB) }) }}</span></div>
                </div>
                <span class="model-deck-main" aria-hidden="true" tw-class="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-blue-100/60 dark:border-blue-500/10 bg-blue-50/70 dark:bg-blue-500/10 px-4 py-3 text-sm font-bold text-blue-600 dark:text-blue-400 group-hover:bg-blue-100/70 dark:group-hover:bg-blue-500/15 transition-colors"><span>{{ lazyStrings.LlamaCppBrowserModelLaunch__start_with_this_model() }}</span><ArrowRightIcon tw-class="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none" /></span>
              </button>
            </div>
          </div>
          <div tw-class="flex min-h-9 items-center justify-center" aria-live="polite">
            <Transition name="discovery-hint">
              <button v-if="discoveryHint === 'visible'" type="button" :disabled="disabled" data-testid="onboarding-hugging-face-hint" aria-haspopup="dialog" tw-class="group inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-medium text-gray-500 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50" @click="emit('open-discovery', { tab: 'hugging-face' })"><SearchIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.BrowserModelWelcome__more_models_on_hugging_face() }}<ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
            </Transition>
          </div>
          <div tw-class="mx-auto w-full max-w-md space-y-1.5 border-t border-gray-100 dark:border-gray-800 px-4 pt-3 text-[12px] text-gray-500 dark:text-gray-400">
            <div tw-class="flex items-center gap-2 leading-relaxed"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><p>{{ lazyStrings.BrowserModelWelcome__drop_gguf_files_or_a_folder_or_choose() }} <span tw-class="inline-flex items-center whitespace-nowrap"><button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__choose_gguf_files()" tw-class="min-h-8 rounded text-gray-600 dark:text-gray-300 underline decoration-gray-300 dark:decoration-gray-600 underline-offset-4 transition-colors motion-reduce:transition-none hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="fileInput?.click()">{{ lazyStrings.BrowserModelWelcome__files() }}</button><span aria-hidden="true" tw-class="mx-1">／</span><button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__choose_a_model_folder()" tw-class="min-h-8 rounded text-gray-600 dark:text-gray-300 underline decoration-gray-300 dark:decoration-gray-600 underline-offset-4 transition-colors motion-reduce:transition-none hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="directoryInput?.click()">{{ lazyStrings.BrowserModelWelcome__folder() }}</button></span></p></div>
            <p tw-class="leading-relaxed">{{ lazyStrings.llamaCppBrowser__runs_llama_cpp_in_the_browser_and_supports_many_gguf_models() }}</p>
          </div>
          <p v-if="startError" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ startError }}</p>
          <input ref="fileInput" type="file" :disabled="disabled" accept=".gguf" multiple tabindex="-1" tw-class="sr-only" :aria-label="lazyStrings.BrowserModelWelcome__choose_gguf_files()" @change="pickFiles({ event: $event, selection: 'files' })" />
          <input ref="directoryInput" type="file" :disabled="disabled" webkitdirectory multiple tabindex="-1" tw-class="sr-only" :aria-label="lazyStrings.BrowserModelWelcome__choose_a_model_folder()" @change="pickFiles({ event: $event, selection: 'directory' })" />
        </div>
      </section>
    </template>
  </WelcomeScreenFrame>
</template>

<style scoped>
@media (min-width: 640px) {
  .onboarding-intro {
    transform: translateY(clamp(-56px, calc((640px - 100dvh) * 0.3), 0px));
  }
}
.onboarding-brand {
  position: relative;
  top: -5px;
  animation: onboarding-brand-appear 600ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes onboarding-brand-appear {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.model-cpu-accent {
  box-shadow: 0 0 26px rgb(56 189 248 / 0), 0 0 10px rgb(59 130 246 / 0);
  transition: box-shadow 650ms ease, color 650ms ease, background-color 650ms ease, border-color 650ms ease;
}
.model-deck-card-selected:hover .model-cpu-accent, .model-deck-card-selected:focus-visible .model-cpu-accent {
  box-shadow: 0 0 26px rgb(56 189 248 / 0.26), 0 0 10px rgb(59 130 246 / 0.14);
  transition-duration: 950ms;
}
.model-deck {
  --model-card-width: min(28rem, calc(100% - 5rem));
  --model-peek-width: clamp(7rem, calc((100% - 28rem) / 2 - 0.75rem), 9rem);
  --model-edge-fade: calc((100% - var(--model-card-width)) / 2);
  height: 11rem;
  overflow: hidden;
  mask-image: linear-gradient(to right, transparent, rgb(0 0 0 / 0.18) calc(var(--model-edge-fade) * 0.3), rgb(0 0 0 / 0.65) calc(var(--model-edge-fade) * 0.7), #000 var(--model-edge-fade), #000 calc(100% - var(--model-edge-fade)), rgb(0 0 0 / 0.65) calc(100% - var(--model-edge-fade) * 0.7), rgb(0 0 0 / 0.18) calc(100% - var(--model-edge-fade) * 0.3), transparent);
}
.model-deck-card {
  position: absolute;
  top: 0.5rem;
  bottom: 0.5rem;
  left: calc(50% + var(--model-offset) * (var(--model-card-width) / 2 + var(--model-peek-width) / 2 + 0.5rem));
  width: var(--model-peek-width);
  transform: translateX(calc(-50% + var(--model-drag, 0px))) scale(0.9);
  opacity: 0.72;
  z-index: 1;
  transition: left 520ms cubic-bezier(0.22, 1, 0.36, 1), width 520ms cubic-bezier(0.22, 1, 0.36, 1), transform 520ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease, border-color 180ms ease, box-shadow 300ms ease;
}
.model-deck-card-selected {
  width: var(--model-card-width);
  transform: translateX(calc(-50% + var(--model-drag, 0px))) scale(1);
  opacity: 1;
  z-index: 2;
}
.model-deck-card-selected:hover {
  box-shadow: 0 3px 12px rgb(0 0 0 / 0.04);
}
.model-deck-card-previous:hover, .model-deck-card-next:hover, .model-deck-card-previous:focus-visible, .model-deck-card-next:focus-visible {
  opacity: 1;
  transform: translateX(calc(-50% + var(--model-drag, 0px))) scale(0.94);
}
.model-deck-card-hidden {
  opacity: 0;
  pointer-events: none;
  z-index: 0;
}
.model-deck-dragging .model-deck-card {
  transition: none;
}
.model-deck-main {
  opacity: 0;
  transition: opacity 160ms ease;
}
.model-deck-card-selected .model-deck-main {
  opacity: 1;
  transition-delay: 140ms;
}
.model-deck-preview {
  opacity: 1;
  transition: opacity 160ms ease;
}
.model-deck-card-selected .model-deck-preview {
  opacity: 0;
}
.discovery-hint-enter-active {
  transition: opacity 380ms ease, transform 480ms cubic-bezier(0.22, 1, 0.36, 1);
  transition-delay: 160ms;
}
.discovery-hint-leave-active {
  transition: opacity 180ms ease;
}
.discovery-hint-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.discovery-hint-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .onboarding-brand {
    animation: none;
  }
  .model-cpu-accent, .model-deck-card, .model-deck-main, .model-deck-preview, .discovery-hint-enter-active, .discovery-hint-leave-active {
    transition: none;
  }
}
</style>
