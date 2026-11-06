<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { createTranslationTextCoverage, translationGraphemes, type TextRectangle } from '@/features/translation/text-overlap';

const props = defineProps<{
  text: string,
  previousText: string,
  revision: number,
  state: 'pending' | 'streaming' | 'settled' | 'failed',
  label: string | undefined,
  placeholder: string | undefined,
}>();
const panel = ref<HTMLElement>();
const back = ref<HTMLElement>();
const front = ref<HTMLElement>();
const glyphs = shallowRef<string[]>([]);
const fading = new Set<number>();
const layerRevision = ref(0);
const backVisible = ref(false);
const retainedHeight = ref<number>();
const reduceMotion = ref(false);
const showPreviousForAccessibility = computed(() => !props.text && props.previousText);
let frame: number | undefined;
let observer: ResizeObserver | undefined;
let media: MediaQueryList | undefined;
let mounted = false, disposed = false;
let geometryDirty = true, textDirty = true;
let layerText: string | undefined;
let geometry: { index: number, rectangles: TextRectangle[] }[] = [];
const due = new Map<number, number>();
let cleanupAt: number | undefined;
const overlapMs = 65, fadeMs = 130;

function schedule(): void {
  if (mounted && !disposed && frame === undefined) {
    frame = requestAnimationFrame(now => paint({ now }));
  }
}

function resetLayers(): void {
  if (frame !== undefined) {
    cancelAnimationFrame(frame);
  }
  frame = undefined;
  due.clear();
  cleanupAt = undefined;
  if (backVisible.value && layerText === props.previousText) {
    // Consecutive source edits keep the same completed translation. Reuse its
    // DOM instead of rebuilding thousands of spans on every keystroke.
    for (const index of fading) {
      back.value?.children[index]?.classList.remove('translation-old-fading');
    }
  } else {
    layerRevision.value++;
    glyphs.value = translationGraphemes({ text: props.previousText });
  }
  fading.clear();
  layerText = props.previousText;
  backVisible.value = !!props.previousText;
  retainedHeight.value = undefined;
  geometry = [];
  geometryDirty = true;
  textDirty = true;
  void nextTick().then(schedule);
}

function rectangles({ element, origin }: { element: HTMLElement, origin: DOMRect }): TextRectangle[] {
  const range = document.createRange();
  range.selectNodeContents(element);
  // Some DOM-only test environments do not implement layout measurement.
  if (typeof range.getClientRects !== 'function') {
    return [];
  }
  return Array.from(range.getClientRects(), rect => ({ left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top }));
}

function paint({ now }: { now: number }): void {
  frame = undefined;
  if (disposed || !backVisible.value || !back.value || !front.value) {
    return;
  }
  if (reduceMotion.value && props.text) {
    backVisible.value = false;
    retainedHeight.value = undefined;
    due.clear();
    return;
  }
  if (geometryDirty) {
    geometryDirty = false;
    textDirty = true;
    due.clear();
    cleanupAt = undefined;
    const origin = back.value.getBoundingClientRect();
    retainedHeight.value = origin.height;
    geometry = [];
  }
  if (textDirty && props.text) {
    textDirty = false;
    // One layout read per streamed update; old grapheme boxes are cached until
    // wrapping changes. Scrolling moves both layers together, not their offsets.
    const fresh = rectangles({ element: front.value, origin: front.value.getBoundingClientRect() });
    const coverage = createTranslationTextCoverage({ rectangles: fresh });
    const bottom = Math.max(0, ...fresh.map(rectangle => rectangle.bottom));
    const origin = back.value.getBoundingClientRect();
    // Plain inline text has monotonically increasing visual lines even when
    // horizontal runs are bidirectional. Measure only lines reached by output;
    // a long untouched suffix needs neither geometry nor repeated VNode updates.
    while (geometry.length < glyphs.value.length) {
      const index = geometry.length;
      const element = back.value.children[index];
      if (!(element instanceof HTMLElement)) {
        break;
      }
      const boxes = rectangles({ element, origin });
      if (boxes.length > 0 && boxes.every(rectangle => rectangle.top > bottom + 0.75)) {
        break;
      }
      geometry.push({ index, rectangles: boxes });
    }
    for (const old of geometry) {
      if (!fading.has(old.index) && !due.has(old.index) && old.rectangles.length > 0 && old.rectangles.every(rectangle => coverage.covers({ rectangle }))) {
        due.set(old.index, now + overlapMs);
      }
    }
  }
  if (props.state === 'settled' && props.text) {
    // A short replacement cannot cover the old suffix or old-only lines.
    // They stay fully opaque until generation is finished, then fade promptly.
    for (let index = 0; index < glyphs.value.length; index++) {
      if (!fading.has(index) && !due.has(index)) {
        due.set(index, now);
      }
    }
    if (cleanupAt === undefined) {
      cleanupAt = Math.max(now, ...due.values()) + fadeMs;
    }
  }
  for (const [index, time] of due) {
    if (now >= time) {
      fading.add(index);
      back.value.children[index]?.classList.add('translation-old-fading');
      due.delete(index);
    }
  }
  if (cleanupAt !== undefined && now >= cleanupAt) {
    backVisible.value = false;
    retainedHeight.value = undefined;
    due.clear();
    cleanupAt = undefined;
  } else if (due.size > 0 || cleanupAt !== undefined) {
    schedule();
  }
}

function resized(): void {
  geometryDirty = true;
  schedule();
}

function motionChanged(): void {
  reduceMotion.value = media?.matches === true;
  schedule();
}

watch([() => props.revision, () => props.previousText], resetLayers, { flush: 'post', immediate: true });
watch([() => props.text, () => props.state], () => {
  const state = props.state;
  switch (state) {
  case 'failed': resetLayers();
    break;
  case 'pending': case 'streaming': case 'settled': textDirty = true;
    schedule();
    break;
  default: {
    const exhaustive: never = state;
    throw new Error(String(exhaustive));
  }
  }
}, { flush: 'post' });
onMounted(() => {
  mounted = true;
  media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  motionChanged();
  media?.addEventListener('change', motionChanged);
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(resized);
    if (panel.value) {
      observer.observe(panel.value);
    }
  }
  // Font loading can change glyph widths without changing the panel's width.
  document.fonts?.addEventListener('loadingdone', resized);
  schedule();
});
onScopeDispose(() => {
  disposed = true;
  if (frame !== undefined) {
    cancelAnimationFrame(frame);
  }
  observer?.disconnect();
  media?.removeEventListener('change', motionChanged);
  document.fonts?.removeEventListener('loadingdone', resized);
  due.clear();
});

function focus(): void {
  panel.value?.focus();
}

defineExpose({ focus, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <pre ref="panel" tabindex="0" :aria-label="label" class="translation-output" tw-class="h-full overflow-y-auto p-4 font-sans text-sm leading-7 outline-none"><span class="translation-output-layers" :style="{ minHeight: retainedHeight === undefined ? undefined : `${retainedHeight}px` }"><span v-if="backVisible" :key="layerRevision" v-memo="[glyphs]" ref="back" dir="auto" aria-hidden="true" data-testid="translation-previous-text" class="translation-output-back"><span v-for="(glyph, index) in glyphs" :key="index" class="translation-old-glyph">{{ glyph }}</span></span><span ref="front" dir="auto" class="translation-output-front" data-testid="translation-current-text">{{ text }}</span></span><span v-if="!text && !previousText" tw-class="text-gray-400 dark:text-gray-500">{{ placeholder }}</span><span v-if="showPreviousForAccessibility" tw-class="sr-only">{{ previousText }}</span></pre>
</template>
<style scoped>
.translation-output {
  white-space: normal;
}
.translation-output-layers {
  position: relative;
  display: block;
}
.translation-output-back, .translation-output-front {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-align: start;
}
.translation-output-back {
  position: absolute;
  inset-inline: 0;
  top: 0;
  pointer-events: none;
  user-select: none;
}
.translation-output-front {
  position: relative;
  z-index: 1;
}
.translation-old-glyph {
  opacity: 1;
  transition: opacity 130ms ease-out;
}
.translation-old-fading {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .translation-old-glyph {
    transition: none;
  }
}
</style>
