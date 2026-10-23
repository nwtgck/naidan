<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CpuIcon, FileIcon, FolderOpenIcon, HardDriveIcon, InfoIcon, ListIcon, MonitorIcon, PlugZapIcon, SearchIcon, ServerOffIcon, ShieldCheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { modelSuggestions, preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api/constants';
import { browserModelShowcaseIds, browserModelSuggestionSelection, type ModelDiscoveryTab, type BrowserModelLocalInput, type BrowserModelSelection } from './browser-model-presentation';
import LanguageSelector from './LanguageSelector.vue';
import Logo from './Logo.vue';
import WelcomeScreenFrame from './layout/WelcomeScreenFrame.vue';

const props = defineProps<{
  interaction: 'blocked' | 'ready',
  selection: BrowserModelSelection,
  startStatus: 'idle' | 'starting',
  startError: string | undefined,
  browserProvidedModel?: { availability: 'available' | 'downloadable' | 'downloading', selection: 'selected' | 'unselected' },
}>();
const emit = defineEmits<{
  select: [selection: BrowserModelSelection],
  start: [],
  'select-browser-model': [selection: 'selected' | 'unselected'],
  'open-connections': [endpoint: 'openai' | 'browser_provided_lm'],
  'open-discovery': [request: { tab: ModelDiscoveryTab }],
  'local-input': [input: BrowserModelLocalInput],
}>();
const disabled = computed(() => props.interaction !== 'ready' || props.startStatus === 'starting');
const models = browserModelShowcaseIds.flatMap(id => {
  const suggestion = modelSuggestions.find(model => model.id === id);
  return suggestion ? [suggestion] : [];
});
const selected = computed(() => browserModelSuggestionSelection({ selection: props.selection }));
const browserCardSelected = computed(() => {
  const selection = props.browserProvidedModel?.selection;
  switch (selection) {
  case 'selected': return true;
  case 'unselected': case undefined: return false;
  default: {
    const exhaustive: never = selection;
    throw new Error(String(exhaustive));
  }
  }
});
const selectedIndex = computed(() => browserCardSelected.value ? models.length : models.findIndex(model => model.id === selected.value?.suggestion.id));
const showcaseCount = computed(() => models.length + (props.browserProvidedModel === undefined ? 0 : 1));
type ModelCardPosition = 'selected' | 'previous' | 'next' | 'hidden';
const modelCards = computed(() => {
  const current = selected.value;
  const ggufModels = current && selectedIndex.value < 0 ? [...models, current.suggestion] : models;
  const ggufCards = ggufModels.map(model => ({
    kind: 'gguf' as const,
    model,
    hint: current && model.id === current.suggestion.id ? current.quantization : preferredQuantizationHint({ suggestion: model }),
  }));
  // Only this showcase omits unsupported browser-provided models. The regular
  // connection chooser still shows the option and explains its availability.
  const candidates = [
    ...ggufCards,
    ...(props.browserProvidedModel === undefined ? [] : [{
      kind: 'browser-provided' as const,
      model: { id: BROWSER_PROVIDED_LM_MODEL_ID, name: lazyStrings.BrowserModelWelcome__browser_provided_model(), developer: lazyStrings.BrowserModelWelcome__this_browser() },
      availability: props.browserProvidedModel.availability,
    }]),
  ];
  const currentId = browserCardSelected.value ? BROWSER_PROVIDED_LM_MODEL_ID : selected.value?.suggestion.id;
  const currentIndex = candidates.findIndex(card => card.model.id === currentId);
  const half = Math.floor(candidates.length / 2);
  return candidates.map((card, index) => {
    const distance = (index - currentIndex + candidates.length + half) % candidates.length - half;
    const position: ModelCardPosition = distance === 0 ? 'selected' : distance === -1 ? 'previous' : distance === 1 ? 'next' : 'hidden';
    return { ...card, position, offset: Math.max(-2, Math.min(2, distance)) };
  });
});
const discoveryHint = ref<'hidden' | 'visible'>('hidden');
const swipeStart = ref<{ source: 'pointer' | 'touch', inputId: number, x: number, y: number, phase: 'pending' | 'dragging' }>();
const swipeOffset = ref(0);
const fileInput = ref<HTMLInputElement>();
const directoryInput = ref<HTMLInputElement>();
const compatibilityHelp = ref<HTMLElement>();
const compatibilityTrigger = ref<HTMLButtonElement>();
const compatibilityId = useId();
const compatibilityVisibility = ref<'closed' | 'transient' | 'pinned'>('closed');
let suppressStartUntil = 0;

function showCompatibility(): void {
  if (!disabled.value && compatibilityVisibility.value === 'closed') {
    compatibilityVisibility.value = 'transient';
  }
}

function leaveCompatibility(): void {
  if (compatibilityVisibility.value === 'transient' && document.activeElement !== compatibilityTrigger.value) {
    compatibilityVisibility.value = 'closed';
  }
}

function toggleCompatibility(): void {
  if (disabled.value) {
    return;
  }
  const visibility = compatibilityVisibility.value;
  switch (visibility) {
  case 'closed': case 'transient': compatibilityVisibility.value = 'pinned';
    break;
  case 'pinned': compatibilityVisibility.value = 'closed';
    break;
  default: {
    const exhaustive: never = visibility;
    throw new Error(String(exhaustive));
  }
  }
}

function compatibilityKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape' && compatibilityVisibility.value !== 'closed') {
    event.preventDefault();
    event.stopPropagation();
    compatibilityVisibility.value = 'closed';
  }
}

useEventTargetListener(document, 'pointerdown', event => {
  if (event.target instanceof Node && !compatibilityHelp.value?.contains(event.target)) {
    compatibilityVisibility.value = 'closed';
  }
});
watch(disabled, blocked => {
  if (blocked) {
    compatibilityVisibility.value = 'closed';
    cancelSwipe();
  }
});
useEventTargetListener(window, 'blur', cancelSwipe);

function selectModel({ index }: { index: number }): void {
  if (disabled.value || !models.length) {
    return;
  }
  const next = (index + showcaseCount.value) % showcaseCount.value;
  emit('select-browser-model', next === models.length ? 'selected' : 'unselected');
  if (next === models.length) {
    return;
  }
  const model = models[next];
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
  case 'selected':
    if (browserCardSelected.value) {
      emit('open-connections', 'browser_provided_lm');
    } else {
      emit('start');
    }
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
  if (disabled.value || event.button !== 0 || !event.isPrimary || swipeStart.value?.source === 'touch') {
    return;
  }
  cancelSwipe();
  suppressStartUntil = 0;
  swipeStart.value = { source: 'pointer', inputId: event.pointerId, x: event.clientX, y: event.clientY, phase: 'pending' };
}

function cancelSwipe(): void {
  swipeStart.value = undefined;
  swipeOffset.value = 0;
}

function moveSwipeTo({ x, y }: { x: number, y: number }): void {
  const start = swipeStart.value;
  if (!start) {
    return;
  }
  const distance = x - start.x;
  const vertical = y - start.y;
  switch (start.phase) {
  case 'pending':
    if (Math.max(Math.abs(distance), Math.abs(vertical)) < 8) {
      return;
    }
    if (Math.abs(vertical) >= Math.abs(distance)) {
      cancelSwipe();
      return;
    }
    start.phase = 'dragging';
    break;
  case 'dragging': break;
  default: {
    const exhaustive: never = start.phase;
    throw new Error(String(exhaustive));
  }
  }
  swipeOffset.value = distance / (1 + Math.abs(distance) / 240);
}

function moveSwipe({ event }: { event: PointerEvent }): void {
  const start = swipeStart.value;
  if (start?.source !== 'pointer' || event.pointerId !== start.inputId) {
    return;
  }
  const wasPending = start.phase === 'pending';
  moveSwipeTo({ x: event.clientX, y: event.clientY });
  // Capture only after horizontal intent is clear. Finger gestures instead
  // use touch events below, without transferring capture off the moving card.
  if (wasPending && swipeStart.value?.phase === 'dragging' && event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
}

function finishSwipeAt({ x }: { x: number }): void {
  const start = swipeStart.value;
  if (!start) {
    return;
  }
  const distance = x - start.x;
  cancelSwipe();
  switch (start.phase) {
  case 'pending': return;
  case 'dragging': break;
  default: {
    const exhaustive: never = start.phase;
    throw new Error(String(exhaustive));
  }
  }
  // A browser click following a swipe must not start the newly centered model.
  suppressStartUntil = Date.now() + 400;
  if (Math.abs(distance) >= 40) {
    moveModel({ step: distance < 0 ? 1 : -1 });
  }
}

function finishSwipe({ event }: { event: PointerEvent }): void {
  if (swipeStart.value?.source === 'pointer' && event.pointerId === swipeStart.value.inputId) {
    finishSwipeAt({ x: event.clientX });
  }
}

function cancelPointerSwipe({ event }: { event: PointerEvent }): void {
  if (swipeStart.value?.source === 'pointer' && event.pointerId === swipeStart.value.inputId) {
    cancelSwipe();
  }
}

function loseSwipeCapture({ event }: { event: PointerEvent }): void {
  // Touch implicitly captures the pressed card first. Its lost-capture event
  // bubbles here when capture moves to the deck; that handoff is not a cancel.
  if (event.target === event.currentTarget) {
    cancelPointerSwipe({ event });
  }
}

function beginTouchSwipe({ event }: { event: TouchEvent }): void {
  if (disabled.value || event.touches.length !== 1) {
    cancelSwipe();
    return;
  }
  const touch = event.touches[0];
  if (!touch) {
    return;
  }
  // Finger tracking stays attached to its initial touch target on iOS Safari,
  // even while the card moves. Ignore the parallel pointer stream from here.
  cancelSwipe();
  suppressStartUntil = 0;
  swipeStart.value = { source: 'touch', inputId: touch.identifier, x: touch.clientX, y: touch.clientY, phase: 'pending' };
}

function activeTouchSwipe() {
  const start = swipeStart.value;
  const source = start?.source;
  switch (source) {
  case 'touch': return start;
  case 'pointer': case undefined: return undefined;
  default: {
    const exhaustive: never = source;
    throw new Error(String(exhaustive));
  }
  }
}

function moveTouchSwipe({ event }: { event: TouchEvent }): void {
  const start = activeTouchSwipe();
  if (!start) {
    return;
  }
  if (event.touches.length !== 1) {
    cancelSwipe();
    return;
  }
  const touch = event.touches[0];
  if (!touch || touch.identifier !== start.inputId) {
    return;
  }
  moveSwipeTo({ x: touch.clientX, y: touch.clientY });
  // This element's touchmove listener is non-passive. Only horizontal dragging
  // cancels native scrolling; vertical gestures and pinch zoom stay native.
  if (swipeStart.value?.phase === 'dragging' && event.cancelable) {
    event.preventDefault();
  }
}

function finishTouchSwipe({ event }: { event: TouchEvent }): void {
  const start = activeTouchSwipe();
  if (!start) {
    return;
  }
  const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start.inputId);
  if (touch) {
    finishSwipeAt({ x: touch.clientX });
  }
}

function cancelTouchSwipe({ event }: { event: TouchEvent }): void {
  const start = activeTouchSwipe();
  if (start && Array.from(event.changedTouches).some(touch => touch.identifier === start.inputId)) {
    cancelSwipe();
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
  <WelcomeScreenFrame class="browser-model-welcome" placement="contained" :inert="interaction === 'blocked' || undefined" data-testid="browser-model-welcome" @keydown.capture="compatibilityKeydown({ event: $event })">
    <template #default>
      <section class="onboarding-content" tw-class="pointer-events-auto mx-auto flex w-full max-w-3xl flex-col">
        <div class="onboarding-language" tw-class="absolute right-4 top-4 z-20 pointer-events-auto sm:right-6 sm:top-6"><LanguageSelector /></div>
        <div class="onboarding-intro" tw-class="mx-auto max-w-2xl space-y-2 [container-type:inline-size]">
          <div class="onboarding-brand" data-testid="onboarding-brand" tw-class="flex items-center justify-center gap-2.5">
            <div tw-class="relative isolate"><span aria-hidden="true" tw-class="pointer-events-none absolute -inset-2 -z-10 rounded-full bg-blue-400/20 blur-xl dark:bg-blue-400/15" /><Logo :size="32" /></div>
            <span tw-class="text-[18px] font-semibold leading-none tracking-tight text-gray-600 dark:text-gray-300">Naidan</span>
          </div>
          <h2 data-testid="browser-model-heading" tw-class="text-balance text-[clamp(24px,6.5cqw,44px)] font-extrabold leading-[1.15] tracking-[-0.035em] text-gray-800 dark:text-gray-100">{{ lazyStrings.BrowserModelWelcome__run_ai_in_your_web_browser() }}</h2>
          <div class="onboarding-benefits" tw-class="mx-auto flex w-fit max-w-full flex-col items-start gap-y-2 py-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
            <span class="onboarding-benefit" tw-class="inline-flex items-center gap-1.5"><ServerOffIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__no_inference_server_required() }}</span>
            <span class="onboarding-benefit" tw-class="inline-flex items-center gap-1.5"><ShieldCheckIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__prompts_stay_on_your_device() }}</span>
            <span tw-class="inline-flex items-center gap-4"><span class="onboarding-benefit" tw-class="inline-flex items-center gap-1.5"><FileIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__gguf_support() }}</span><span class="onboarding-benefit" tw-class="inline-flex items-center gap-1.5"><CheckIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.BrowserModelWelcome__no_installation_required() }}</span></span>
          </div>
        </div>
        <div role="group" :aria-label="lazyStrings.BrowserModelWelcome__choose_the_model_to_use()" tw-class="mx-auto w-full text-left space-y-2">
          <div class="model-toolbar" tw-class="mx-auto flex w-full max-w-md items-center justify-between gap-3">
            <div class="model-pagination" role="group" :aria-label="lazyStrings.BrowserModelWelcome__browse_models()" tw-class="flex shrink-0 items-center gap-1">
              <button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__previous_model()" data-testid="previous-model" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="moveModel({ step: -1 })"><ChevronLeftIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
              <span tw-class="min-w-9 text-center text-[12px] tabular-nums text-gray-400 dark:text-gray-500">{{ selectedIndex < 0 ? lazyStrings.BrowserModelWelcome__selected_model() : `${selectedIndex + 1} / ${showcaseCount}` }}</span>
              <button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__next_model()" data-testid="next-model" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="moveModel({ step: 1 })"><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            </div>
            <button type="button" class="model-list-button" :disabled="disabled" data-testid="open-model-list" aria-haspopup="dialog" tw-class="group inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100/80 dark:hover:bg-gray-800/70 hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50" @click="emit('open-discovery', { tab: 'candidates' })"><ListIcon aria-hidden="true" tw-class="h-4 w-4 text-gray-500 dark:text-gray-400" />{{ lazyStrings.BrowserModelWelcome__choose_a_model() }}<ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
          </div>
          <p v-if="browserProvidedModel?.selection === 'selected'" role="status" tw-class="sr-only">{{ lazyStrings.BrowserModelWelcome__browser_provided_model() }}</p>
          <p v-else-if="selected" role="status" tw-class="sr-only">{{ selected.suggestion.name }} {{ modelSize({ bytes: selected.quantization.approximateModelBytes }) }}</p>
          <div class="model-stage" tw-class="relative isolate">
            <div class="model-deck" :class="{ 'model-deck-dragging': swipeStart?.phase === 'dragging' }" :style="{ '--model-drag': `${swipeOffset}px` }" data-testid="model-swipe" tw-class="relative select-none [touch-action:pan-y_pinch-zoom]" @pointerdown="beginSwipe({ event: $event })" @pointermove="moveSwipe({ event: $event })" @pointerup="finishSwipe({ event: $event })" @pointercancel="cancelPointerSwipe({ event: $event })" @lostpointercapture="loseSwipeCapture({ event: $event })" @touchstart.passive="beginTouchSwipe({ event: $event })" @touchmove="moveTouchSwipe({ event: $event })" @touchend="finishTouchSwipe({ event: $event })" @touchcancel="cancelTouchSwipe({ event: $event })" @keydown.left.prevent="moveModel({ step: -1 })" @keydown.right.prevent="moveModel({ step: 1 })">
              <button v-for="card in modelCards" :key="card.model.id" type="button" class="model-deck-card" :class="{ 'model-deck-card-selected': card.position === 'selected', 'model-deck-card-previous': card.position === 'previous', 'model-deck-card-next': card.position === 'next', 'model-deck-card-hidden': card.position === 'hidden' }" :style="{ '--model-offset': card.offset }" :data-testid="card.position === 'selected' ? 'start-model' : card.position === 'hidden' ? undefined : `peek-${card.position}`" :aria-label="card.model.name === undefined ? undefined : card.position === 'selected' ? lazyStrings.BrowserModelWelcome__start_with_model({ name: card.model.name }) : lazyStrings.BrowserModelWelcome__select_model({ name: card.model.name })" :aria-hidden="card.position === 'hidden' ? true : undefined" :aria-busy="card.position === 'selected' && startStatus === 'starting'" :disabled="disabled || card.position === 'hidden'" :tabindex="card.position === 'hidden' ? -1 : 0" tw-class="group overflow-hidden rounded-2xl border border-gray-200/70 dark:border-gray-700/60 bg-white/50 dark:bg-gray-800/40 text-left hover:border-blue-400 dark:hover:border-blue-500 hover:bg-white dark:hover:bg-gray-800 focus-visible:bg-white dark:focus-visible:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-default" @click="activateCard({ position: card.position })">
                <span class="model-deck-preview model-deck-preview-action" aria-hidden="true" tw-class="absolute inset-x-0 bottom-4 flex items-center justify-center gap-1 text-[11px] text-gray-400 dark:text-gray-500"><ArrowRightIcon v-if="card.position === 'previous'" tw-class="h-3 w-3" />{{ lazyStrings.BrowserModelWelcome__select() }}<ArrowLeftIcon v-if="card.position === 'next'" tw-class="h-3 w-3" /></span>
                <div class="model-deck-content" aria-hidden="true" tw-class="flex min-h-0 flex-col justify-center gap-3 px-3 py-3">
                  <!-- One identity travels with its card; do not crossfade duplicate model names. -->
                  <div class="model-deck-identity" tw-class="flex items-center"><div class="model-deck-cpu"><div class="model-cpu-accent" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 text-gray-400 dark:text-gray-500 group-hover:border-sky-200/80 dark:group-hover:border-sky-400/25 group-hover:bg-sky-50 dark:group-hover:bg-sky-400/10 group-hover:text-sky-600 dark:group-hover:text-sky-300 group-focus-visible:border-sky-200/80 dark:group-focus-visible:border-sky-400/25 group-focus-visible:bg-sky-50 dark:group-focus-visible:bg-sky-400/10 group-focus-visible:text-sky-600 dark:group-focus-visible:text-sky-300"><MonitorIcon v-if="card.kind === 'browser-provided'" tw-class="w-5 h-5" /><CpuIcon v-else tw-class="w-5 h-5" /></div></div><div tw-class="min-w-0"><p tw-class="whitespace-nowrap text-[12px] text-gray-500 dark:text-gray-400">{{ card.model.developer }}</p><h3 class="model-deck-name" tw-class="font-semibold text-gray-600 dark:text-gray-400 tracking-tight leading-snug [overflow-wrap:anywhere] group-hover:text-gray-800 dark:group-hover:text-gray-100 group-focus-visible:text-gray-800 dark:group-focus-visible:text-gray-100 transition-colors duration-300 motion-reduce:transition-none">{{ card.model.name }}</h3></div></div>
                  <div v-if="card.kind === 'gguf'" class="model-deck-main model-deck-metadata" tw-class="flex flex-col gap-y-1 text-[11px] text-gray-500 dark:text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-400 group-focus-visible:text-gray-600 dark:group-focus-visible:text-gray-400 transition-colors duration-300 motion-reduce:transition-none"><span tw-class="inline-flex items-center gap-1 whitespace-nowrap"><HardDriveIcon tw-class="h-3.5 w-3.5 shrink-0" />{{ modelSize({ bytes: card.hint.approximateModelBytes }) }}</span><span tw-class="whitespace-nowrap">{{ lazyStrings.llamaCppBrowser__memory_estimate_gib({ memory: String(card.hint.suggestedMemoryGiB) }) }}</span></div>
                  <div v-else class="model-deck-main model-deck-metadata" tw-class="space-y-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400"><span tw-class="flex items-center gap-1.5"><ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.BrowserModelWelcome__processed_on_this_device() }}</span><span v-if="card.availability !== 'available'">{{ card.availability === 'downloading' ? lazyStrings.BrowserModelWelcome__the_browser_is_preparing_the_model() : lazyStrings.BrowserModelWelcome__the_browser_handles_initial_preparation() }}</span></div>
                </div>
                <span class="model-deck-main model-deck-start" aria-hidden="true" tw-class="flex items-center justify-between gap-2 border-t border-gray-200/60 dark:border-gray-700/50 bg-gray-50/60 dark:bg-gray-900/15 px-3 py-3 text-[13px] font-bold leading-snug text-gray-600 dark:text-gray-400 group-hover:border-blue-100/60 dark:group-hover:border-blue-500/10 group-hover:bg-blue-50/70 dark:group-hover:bg-blue-500/10 group-hover:text-blue-600 dark:group-hover:text-blue-400 group-focus-visible:border-blue-100/60 dark:group-focus-visible:border-blue-500/10 group-focus-visible:bg-blue-50/70 dark:group-focus-visible:bg-blue-500/10 group-focus-visible:text-blue-600 dark:group-focus-visible:text-blue-400 transition-colors duration-300 motion-reduce:transition-none"><span tw-class="min-w-0 text-balance">{{ lazyStrings.LlamaCppBrowserModelLaunch__start_with_this_model() }}</span><ArrowRightIcon tw-class="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none" /></span>
              </button>
            </div>
          </div>
          <div tw-class="flex min-h-9 items-center justify-center" aria-live="polite">
            <Transition name="discovery-hint">
              <button v-if="discoveryHint === 'visible'" type="button" :disabled="disabled" data-testid="onboarding-hugging-face-hint" aria-haspopup="dialog" tw-class="group inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-medium text-gray-500 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50" @click="emit('open-discovery', { tab: 'hugging-face' })"><SearchIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.BrowserModelWelcome__more_models_on_hugging_face() }}<ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
            </Transition>
          </div>
          <div class="onboarding-local-files" data-testid="onboarding-local-files" tw-class="relative z-10 mx-auto w-full max-w-md border-t border-gray-100 dark:border-gray-800 px-1 pt-3 text-[12px] text-gray-500 dark:text-gray-400">
            <div tw-class="flex items-center gap-2 leading-relaxed"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><p>{{ lazyStrings.BrowserModelWelcome__drop_gguf_files_or_a_folder_or_choose() }} <span tw-class="inline-flex items-center whitespace-nowrap"><button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__choose_gguf_files()" tw-class="min-h-8 rounded text-gray-600 dark:text-gray-300 underline decoration-gray-300 dark:decoration-gray-600 underline-offset-4 transition-colors motion-reduce:transition-none hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="fileInput?.click()">{{ lazyStrings.BrowserModelWelcome__files() }}</button><span aria-hidden="true" tw-class="mx-1">／</span><button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__choose_a_model_folder()" tw-class="min-h-8 rounded text-gray-600 dark:text-gray-300 underline decoration-gray-300 dark:decoration-gray-600 underline-offset-4 transition-colors motion-reduce:transition-none hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="directoryInput?.click()">{{ lazyStrings.BrowserModelWelcome__folder() }}</button>
              <span ref="compatibilityHelp" data-testid="gguf-compatibility-info" tw-class="ml-1 inline-flex items-center" @mouseenter="showCompatibility" @mouseleave="leaveCompatibility" @focusout="compatibilityVisibility = 'closed'">
                <button ref="compatibilityTrigger" type="button" :disabled="disabled" data-testid="gguf-compatibility-info-trigger" :aria-label="lazyStrings.BrowserModelWelcome__gguf_support()" :aria-expanded="compatibilityVisibility !== 'closed'" :aria-controls="compatibilityId" :aria-describedby="compatibilityVisibility !== 'closed' ? compatibilityId : undefined" tw-class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors duration-200 hover:bg-gray-100 hover:text-blue-500 focus-visible:text-blue-500 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-blue-400 dark:focus-visible:text-blue-400 motion-reduce:transition-none" @focus="showCompatibility" @click="toggleCompatibility"><InfoIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
                <Transition tw-enter-active-class="transition-[opacity,transform] duration-180 ease-out motion-reduce:transition-none" tw-leave-active-class="transition-opacity duration-120 motion-reduce:transition-none" tw-enter-from-class="opacity-0 translate-y-1" tw-leave-to-class="opacity-0">
                  <!-- Anchor to the full file row, keeping the explanation inside
                       narrow dialogs. Padding bridges the pointer path upward. -->
                  <span v-if="compatibilityVisibility !== 'closed'" :id="compatibilityId" role="tooltip" data-testid="gguf-compatibility-tooltip" tw-class="absolute right-0 bottom-full z-30 w-full max-w-sm whitespace-normal pb-2 text-left"><span tw-class="flex items-start gap-2.5 rounded-xl border border-gray-200/70 bg-white/95 p-3 text-xs leading-5 text-gray-600 shadow-lg shadow-gray-950/5 backdrop-blur-sm dark:border-gray-700/70 dark:bg-gray-800/95 dark:text-gray-300 dark:shadow-black/20"><InfoIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><span tw-class="min-w-0">{{ lazyStrings.llamaCppBrowser__runs_llama_cpp_in_the_browser_and_supports_many_gguf_models() }}</span></span></span>
                </Transition>
              </span>
            </span></p></div>
          </div>
          <!-- The subtitle distinguishes API/server connections from the GGUF cards.
               Browser-provided deliberately remains available in the destination,
               even though this wording can suggest it also runs outside the browser. -->
          <button type="button" :disabled="disabled" data-testid="open-connections" tw-class="group mx-auto flex min-h-12 w-full max-w-md items-center gap-3 rounded-xl px-3 py-2 text-left text-gray-500 transition-colors hover:bg-gray-100/70 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-100 disabled:opacity-50" @click="emit('open-connections', 'openai')"><span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200/70 bg-white/50 dark:border-gray-700/70 dark:bg-gray-800/40"><PlugZapIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></span><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">{{ lazyStrings.BrowserModelWelcome__use_openai_ollama_and_more() }}</span><span tw-class="mt-0.5 block text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.BrowserModelWelcome__connect_to_ai_running_outside_the_web_browser() }}</span></span><ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
          <p v-if="startError" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ startError }}</p>
          <input ref="fileInput" type="file" :disabled="disabled" accept=".gguf" multiple tabindex="-1" tw-class="sr-only" :aria-label="lazyStrings.BrowserModelWelcome__choose_gguf_files()" @change="pickFiles({ event: $event, selection: 'files' })" />
          <input ref="directoryInput" type="file" :disabled="disabled" webkitdirectory multiple tabindex="-1" tw-class="sr-only" :aria-label="lazyStrings.BrowserModelWelcome__choose_a_model_folder()" @change="pickFiles({ event: $event, selection: 'directory' })" />
        </div>
      </section>
    </template>
  </WelcomeScreenFrame>
</template>

<style scoped>
.browser-model-welcome {
  --welcome-gutter: clamp(0.75rem, 3vw, 2rem);
  container: browser-model-welcome / inline-size;
  justify-content: flex-start;
  padding-inline: var(--welcome-gutter);
  padding-top: clamp(4.5rem, 12dvh, 9rem);
  padding-bottom: 1.5rem;
}
.onboarding-content {
  gap: clamp(1.25rem, 3dvh, 2.5rem);
}
.onboarding-intro {
  width: 100%;
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
  --model-card-width: min(28rem, max(11.5rem, 62cqw));
  --model-identity-icon-width: 0rem;
  --model-visible-peek: calc((100cqw - var(--model-card-width)) / 2 - 0.5rem);
  --model-edge-fade: clamp(1.25rem, calc(var(--model-visible-peek) * 0.55), 4rem);
  height: 13.5rem;
  overflow: hidden;
  mask-image: linear-gradient(to right, transparent, rgb(0 0 0 / 0.7) calc(var(--model-edge-fade) * 0.45), #000 var(--model-edge-fade), #000 calc(100% - var(--model-edge-fade)), rgb(0 0 0 / 0.7) calc(100% - var(--model-edge-fade) * 0.45), transparent);
}
.model-stage {
  container: model-stage / inline-size;
  margin-inline: calc(-1 * var(--welcome-gutter));
}
.model-deck-card {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  position: absolute;
  top: 0.5rem;
  bottom: 0.5rem;
  /* Every card keeps its full width; neighboring cards continue beyond the fog. */
  left: 50%;
  width: var(--model-card-width);
  touch-action: pan-y pinch-zoom;
  transform: translateX(calc(-50% + var(--model-offset) * (var(--model-card-width) + 0.5rem) + var(--model-drag, 0px)));
  opacity: 0.9;
  z-index: 1;
  transition: transform 520ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease, border-color 180ms ease, background-color 300ms ease, box-shadow 300ms ease;
}
.model-deck-card-selected {
  opacity: 1;
  z-index: 2;
}
.model-deck-card-selected:hover, .model-deck-card-selected:focus-visible {
  box-shadow: 0 3px 12px rgb(0 0 0 / 0.04);
}
.model-deck-card-previous:hover, .model-deck-card-next:hover, .model-deck-card-previous:focus-visible, .model-deck-card-next:focus-visible {
  opacity: 1;
}
.model-deck-card-hidden {
  opacity: 0;
  pointer-events: none;
  z-index: 0;
}
.model-deck-dragging .model-deck-card {
  transition: none;
}
.model-deck-identity {
  transform: translateX(calc(-1 * var(--model-identity-icon-width)));
  transition: transform 520ms cubic-bezier(0.22, 1, 0.36, 1);
}
.model-deck-card-selected .model-deck-identity {
  transform: translateX(0);
}
.model-deck-card-previous .model-deck-identity {
  transform: translateX(calc(var(--model-card-width) - var(--model-visible-peek) - 0.75rem + var(--model-edge-fade) * 0.45 - var(--model-identity-icon-width)));
}
.model-deck-cpu {
  display: none;
  flex-shrink: 0;
  width: var(--model-identity-icon-width);
  opacity: 0;
  transition: opacity 240ms ease;
}
.model-cpu-accent {
  width: 3rem;
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
.model-deck-preview-action {
  inset-inline-start: 0;
  inset-inline-end: auto;
  width: var(--model-visible-peek);
}
.model-deck-card-previous .model-deck-preview-action {
  inset-inline-start: auto;
  inset-inline-end: 0;
}
.model-deck-name {
  /* Keep glyph size and wrapping stable throughout the card's movement. */
  font-size: clamp(16px, 2.8cqw, 20px);
  white-space: normal;
}
.model-deck-card-selected .model-deck-preview {
  opacity: 0;
}
/* Respond to the space left by the sidebar rather than the viewport width. */
@container browser-model-welcome (min-width: 36rem) {
  .onboarding-benefits {
    width: 100%;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    column-gap: 1rem;
    font-size: 13px;
  }
  .model-deck {
    --model-identity-icon-width: 3.75rem;
    height: 12rem;
  }
  .model-deck-cpu {
    display: block;
  }
  .model-deck-card-selected .model-deck-cpu {
    opacity: 1;
  }
  .model-deck-content, .model-deck-start {
    padding-inline: 1rem;
  }
  .model-deck-metadata {
    flex-direction: row;
    flex-wrap: wrap;
    column-gap: 1rem;
    font-size: 12px;
  }
  .model-deck-start {
    font-size: 14px;
  }
}
@container browser-model-welcome (max-width: 30rem) {
  .model-deck-preview-action {
    display: none;
  }
}
@container browser-model-welcome (max-width: 22rem) {
  .model-toolbar {
    gap: 0.25rem;
  }
  .model-pagination {
    gap: 0.125rem;
  }
  .model-pagination button {
    width: 2rem;
  }
  .model-list-button {
    column-gap: 0.375rem;
    padding-inline: 0.375rem;
    font-size: 13px;
  }
}
@media (max-height: 720px) {
  .browser-model-welcome {
    padding-top: 4rem;
  }
  .onboarding-content {
    gap: 1rem;
  }
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
  .model-cpu-accent, .model-deck-card, .model-deck-identity, .model-deck-cpu, .model-deck-name, .model-deck-main, .model-deck-preview, .discovery-hint-enter-active, .discovery-hint-leave-active {
    transition: none;
  }
}
</style>
