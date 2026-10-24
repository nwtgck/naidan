<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, useId, watch } from 'vue';
import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, FileIcon, FolderOpenIcon, InfoIcon, ListIcon, PlugZapIcon, SearchIcon, ServerOffIcon, ShieldCheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { modelSuggestions, preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api/constants';
import { browserModelShowcaseIds, browserModelSuggestionSelection, type ModelDiscoveryTab, type BrowserModelLocalInput, type BrowserModelSelection, type BrowserModelShowcaseItem, type BrowserModelShowcasePosition } from './browser-model-presentation';
import BrowserModelShowcaseCard from './BrowserModelShowcaseCard.vue';
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
  'open-discovery': [request: { tab: ModelDiscoveryTab | undefined }],
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
const modelCards = computed<BrowserModelShowcaseItem[]>(() => {
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
    const position: BrowserModelShowcasePosition = distance === 0 ? 'selected' : distance === -1 ? 'previous' : distance === 1 ? 'next' : 'hidden';
    return { ...card, position, offset: Math.max(-2, Math.min(2, distance)) };
  });
});
const benefits = computed(() => [
  { id: 'privacy' as const, icon: ShieldCheckIcon, text: lazyStrings.BrowserModelWelcome__prompts_stay_on_your_device() },
  { id: 'server' as const, icon: ServerOffIcon, text: lazyStrings.BrowserModelWelcome__no_inference_server_required() },
  { id: 'gguf' as const, icon: FileIcon, text: lazyStrings.BrowserModelWelcome__gguf_support() },
]);
const benefitContainer = ref<HTMLElement>();
const benefitMeasurement = ref<HTMLElement>();
const benefitLayout = ref<'inline' | 'rotating'>('rotating');
let benefitObserver: ResizeObserver | undefined;

function updateBenefitLayout(): void {
  const container = benefitContainer.value;
  const measurement = benefitMeasurement.value;
  if (!container || !measurement || benefits.value.some(benefit => benefit.text === undefined)) {
    return;
  }
  // Compare both in the same coordinate space, including the modal's opening
  // scale. The hidden row uses the same text, icons, font, and gaps without wrapping.
  const available = container.getBoundingClientRect().width;
  const required = measurement.getBoundingClientRect().width;
  if (available > 0 && required > 0) {
    benefitLayout.value = required <= available ? 'inline' : 'rotating';
  }
}

onMounted(() => {
  updateBenefitLayout();
  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', updateBenefitLayout);
    return;
  }
  benefitObserver = new ResizeObserver(updateBenefitLayout);
  if (benefitContainer.value) {
    benefitObserver.observe(benefitContainer.value);
  }
  if (benefitMeasurement.value) {
    benefitObserver.observe(benefitMeasurement.value);
  }
});
watch(benefits, updateBenefitLayout, { flush: 'post' });
onScopeDispose(() => {
  benefitObserver?.disconnect();
  window.removeEventListener('resize', updateBenefitLayout);
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

function activateCard({ position }: { position: BrowserModelShowcasePosition }): void {
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
          <!-- All claims stay available to assistive reading; CSS changes only
               which one is visible, without repeated live announcements. -->
          <div ref="benefitContainer" data-testid="onboarding-benefits" class="onboarding-benefits" :data-benefit-layout="benefitLayout" role="list" tw-class="relative mx-auto grid w-full max-w-full overflow-hidden py-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
            <span v-for="benefit in benefits" :key="benefit.id" class="onboarding-benefit" :class="{ 'onboarding-benefit-privacy': benefit.id === 'privacy', 'onboarding-benefit-server': benefit.id === 'server', 'onboarding-benefit-gguf': benefit.id === 'gguf' }" role="listitem" tw-class="inline-flex items-center gap-1.5"><component :is="benefit.icon" aria-hidden="true" tw-class="w-3.5 h-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><span>{{ benefit.text }}</span></span>
            <!-- Measure the actual translated labels; this row never participates
                 in layout or accessibility, and performs no data loading. -->
            <div ref="benefitMeasurement" data-testid="onboarding-benefit-measurement" class="onboarding-benefit-measurement" aria-hidden="true">
              <span v-for="benefit in benefits" :key="benefit.id" tw-class="inline-flex shrink-0 items-center gap-1.5"><component :is="benefit.icon" tw-class="w-3.5 h-3.5 shrink-0" /><span>{{ benefit.text }}</span></span>
            </div>
          </div>
        </div>
        <div role="group" :aria-label="lazyStrings.BrowserModelWelcome__choose_the_model_to_use()" tw-class="mx-auto w-full text-left space-y-2">
          <div class="model-toolbar" tw-class="mx-auto flex w-full max-w-md items-center justify-between gap-3">
            <div class="model-pagination" role="group" :aria-label="lazyStrings.BrowserModelWelcome__browse_models()" tw-class="flex shrink-0 items-center gap-1">
              <button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__previous_model()" data-testid="previous-model" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="moveModel({ step: -1 })"><ChevronLeftIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
              <span tw-class="min-w-9 whitespace-nowrap text-center text-[12px] tabular-nums text-gray-400 dark:text-gray-500">
                <template v-if="selectedIndex < 0">{{ lazyStrings.BrowserModelWelcome__selected_model() }}</template>
                <template v-else>{{ selectedIndex + 1 }} / <span class="model-showcase-total"><Transition name="model-showcase-total" mode="out-in"><span :key="showcaseCount">{{ showcaseCount }}</span></Transition></span></template>
              </span>
              <button type="button" :disabled="disabled" :aria-label="lazyStrings.BrowserModelWelcome__next_model()" data-testid="next-model" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="moveModel({ step: 1 })"><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            </div>
            <button type="button" class="model-list-button" :disabled="disabled" data-testid="open-model-list" aria-haspopup="dialog" tw-class="group inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100/80 dark:hover:bg-gray-800/70 hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50" @click="emit('open-discovery', { tab: undefined })"><ListIcon aria-hidden="true" tw-class="h-4 w-4 text-gray-500 dark:text-gray-400" />{{ lazyStrings.BrowserModelWelcome__choose_a_model() }}<ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
          </div>
          <p v-if="browserProvidedModel?.selection === 'selected'" role="status" tw-class="sr-only">{{ lazyStrings.BrowserModelWelcome__browser_provided_model() }}</p>
          <p v-else-if="selected" role="status" tw-class="sr-only">{{ selected.suggestion.name }} {{ modelSize({ bytes: selected.quantization.approximateModelBytes }) }}</p>
          <div class="model-stage" tw-class="relative isolate">
            <div class="model-deck" :class="{ 'model-deck-dragging': swipeStart?.phase === 'dragging' }" :style="{ '--model-drag': `${swipeOffset}px` }" data-testid="model-swipe" tw-class="relative select-none [touch-action:pan-y_pinch-zoom]" @pointerdown="beginSwipe({ event: $event })" @pointermove="moveSwipe({ event: $event })" @pointerup="finishSwipe({ event: $event })" @pointercancel="cancelPointerSwipe({ event: $event })" @lostpointercapture="loseSwipeCapture({ event: $event })" @touchstart.passive="beginTouchSwipe({ event: $event })" @touchmove="moveTouchSwipe({ event: $event })" @touchend="finishTouchSwipe({ event: $event })" @touchcancel="cancelTouchSwipe({ event: $event })" @keydown.left.prevent="moveModel({ step: -1 })" @keydown.right.prevent="moveModel({ step: 1 })">
              <!-- Capability detection can append a browser model after first paint.
                   Fade in that new card without replaying the existing cards. -->
              <Transition v-for="card in modelCards" :key="card.model.id" name="model-showcase-card" type="animation" :appear="card.kind === 'browser-provided'">
                <BrowserModelShowcaseCard :card="card" :interaction="disabled ? 'blocked' : 'ready'" :start-status="startStatus" @activate="activateCard($event)" />
              </Transition>
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
          <button type="button" :disabled="disabled" data-testid="open-connections" tw-class="group mx-auto flex min-h-12 w-full max-w-md items-center gap-3 rounded-xl px-3 py-2 text-left text-gray-500 transition-colors hover:bg-gray-100/50 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-500 dark:hover:bg-gray-800/40 dark:hover:text-gray-300 disabled:opacity-50" @click="emit('open-connections', 'openai')"><span tw-class="flex h-8 w-8 shrink-0 items-center justify-center text-gray-400 dark:text-gray-600"><PlugZapIcon aria-hidden="true" :stroke-width="1.5" tw-class="h-3.5 w-3.5" /></span><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs">{{ lazyStrings.BrowserModelWelcome__use_openai_ollama_and_more() }}</span><span tw-class="mt-0.5 block text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.BrowserModelWelcome__connect_to_ai_running_outside_the_web_browser() }}</span></span><ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-600 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
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
.model-deck {
  --model-card-width: min(28rem, max(11.5rem, 62cqw));
  --model-visible-peek: calc((100cqw - var(--model-card-width)) / 2 - 0.5rem);
  --model-edge-fade: clamp(1.25rem, calc(var(--model-visible-peek) * 0.55), 4rem);
  /* Stacked grid items share the height their content needs at this width. */
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  padding-block: 0.5rem;
  overflow: hidden;
  mask-image: linear-gradient(to right, transparent, rgb(0 0 0 / 0.7) calc(var(--model-edge-fade) * 0.45), #000 var(--model-edge-fade), #000 calc(100% - var(--model-edge-fade)), rgb(0 0 0 / 0.7) calc(100% - var(--model-edge-fade) * 0.45), transparent);
}
.model-stage {
  container: model-stage / inline-size;
  margin-inline: calc(-1 * var(--welcome-gutter));
}
.model-deck-dragging .model-deck-card {
  transition: none;
}
.onboarding-benefits {
  --benefit-inline-gap: 1rem;
}
.onboarding-benefit {
  /* One shared grid cell reserves the height of the longest translation.
     Each label owns four seconds of this twelve-second cycle. */
  grid-area: 1 / 1;
  align-self: center;
  justify-self: center;
  min-width: 0;
  max-width: 100%;
  opacity: 0;
  animation: onboarding-benefit-cycle 12s ease-in-out infinite both;
}
.onboarding-benefit-server {
  animation-delay: 4s;
}
.onboarding-benefit-gguf {
  animation-delay: 8s;
}
.onboarding-benefits[data-benefit-layout="inline"] {
  display: flex;
  justify-content: center;
  gap: var(--benefit-inline-gap);
}
.onboarding-benefits[data-benefit-layout="inline"] > .onboarding-benefit {
  flex-shrink: 0;
  white-space: nowrap;
  opacity: 1;
  transform: none;
  animation: none;
}
.onboarding-benefit-measurement {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-wrap: nowrap;
  gap: var(--benefit-inline-gap);
  width: max-content;
  white-space: nowrap;
  visibility: hidden;
  pointer-events: none;
}
@keyframes onboarding-benefit-cycle {
  0% {
    opacity: 0;
    transform: translateY(3px);
  }
  2%, 31.6667% {
    opacity: 1;
    transform: translateY(0);
  }
  33.3333%, 100% {
    opacity: 0;
    transform: translateY(-3px);
  }
}
.model-deck :deep(.model-showcase-card-enter-active) {
  /* Animate only opacity; the card keeps its existing slide transform. */
  animation: model-showcase-card-added 800ms ease-out both;
}
@keyframes model-showcase-card-added {
  from {
    opacity: 0;
  }
}
.model-showcase-total {
  display: inline-block;
  min-width: 1ch;
}
.model-showcase-total-enter-active {
  transition: opacity 260ms ease-out;
}
.model-showcase-total-leave-active {
  transition: opacity 120ms ease-in;
}
.model-showcase-total-enter-from, .model-showcase-total-leave-to {
  opacity: 0;
}
/* Respond to the space left by the sidebar rather than the viewport width. */
@container browser-model-welcome (min-width: 36rem) {
  .onboarding-benefits {
    font-size: 13px;
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
    gap: var(--benefit-inline-gap);
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
  .onboarding-benefits {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem 1rem;
  }
  .onboarding-benefit {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .onboarding-brand {
    animation: none;
  }
  .model-deck :deep(.model-showcase-card-enter-active) {
    animation: none;
  }
  .model-showcase-total-enter-active, .model-showcase-total-leave-active, .discovery-hint-enter-active, .discovery-hint-leave-active {
    transition: none;
  }
}
</style>
