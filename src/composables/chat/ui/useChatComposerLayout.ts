import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

/** Reserve only the part of the floating composer covering the message viewport. */
export function useChatComposerLayout({ composer, editor, viewport, visibility, display }: {
  composer: Readonly<Ref<HTMLElement | null | undefined>>,
  editor: Readonly<Ref<HTMLTextAreaElement | null | undefined>>,
  viewport: Readonly<Ref<HTMLElement | null>>,
  visibility: Readonly<Ref<'submerged' | 'peeking' | 'active'>>,
  display: Readonly<Ref<'visible' | 'hidden'>>,
}) {
  const bottomPaddingPx = ref(0);
  const availableSpace = ref({ width: 0, height: 0 });
  let observer: ResizeObserver | undefined;
  let disposed = false;
  let measurement = 0;
  let editorTypography: string | undefined;
  let editorWidth = 0;
  let measuredComposer: HTMLElement | undefined;
  const transitions = new Set<HTMLElement>();
  let preserveReading = false;

  function beginTransition({ event }: { event: Pick<TransitionEvent, 'target' | 'propertyName'> }) {
    if ((event.target === composer.value || event.target === editor.value) && event.target instanceof HTMLElement && (event.propertyName === 'height' || event.propertyName === 'transform')) {
      if (transitions.size === 0 && viewport.value) {
        const scroll = viewport.value;
        preserveReading = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 150;
      }
      transitions.add(event.target);
    }
  }

  function finishTransition({ event }: { event: Pick<TransitionEvent, 'target' | 'propertyName'> }) {
    measure();
    if (event.target instanceof HTMLElement && (event.propertyName === 'height' || event.propertyName === 'transform')) {
      transitions.delete(event.target);
      if (transitions.size === 0) {
        preserveReading = false;
      }
    }
  }

  function measure() {
    if (disposed) {
      return;
    }
    const scroll = viewport.value;
    const input = composer.value;
    const rect = scroll?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    const metricElement = editor.value ?? input;
    const editorStyle = metricElement ? getComputedStyle(metricElement) : undefined;
    const typography = editorStyle ? `${editorStyle.fontSize}/${editorStyle.lineHeight}/${editorStyle.fontFamily}` : undefined;
    const width = editor.value?.getBoundingClientRect().width ?? inputRect?.width ?? 0;
    // Typography and the max-width card can change while the pane keeps the
    // same dimensions. Reflow once per metric change, not every observer call.
    if (rect && (availableSpace.value.width !== rect.width || availableSpace.value.height !== rect.height || typography !== editorTypography || width !== editorWidth)) {
      availableSpace.value = { width: rect.width, height: rect.height };
    }
    editorTypography = typography;
    editorWidth = width;
    const overlap = display.value === 'visible' && rect && inputRect && rect.width > 0 && rect.height > 0 && inputRect.width > 0 && inputRect.height > 0
      ? Math.max(0, Math.min(rect.bottom, inputRect.bottom) - Math.max(rect.top, inputRect.top))
      : 0;
    const padding = overlap > 0 ? Math.ceil(overlap + 8) : 0;
    const wasMeasured = measuredComposer === input;
    if (input) {
      measuredComposer = input;
    }
    if (bottomPaddingPx.value === padding || !scroll) {
      return;
    }
    // Test before changing the padding: the new reserve itself must not make a
    // previously following reader look far from the end (or move a reader upthread).
    // Initial-open scrolling owns the first measurement of a new composer.
    const nearBottom = wasMeasured && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 150;
    if (transitions.size > 0 && !nearBottom) {
      preserveReading = true;
    }
    const shouldFollow = nearBottom && !preserveReading;
    const scrollTop = scroll.scrollTop;
    const currentMeasurement = ++measurement;
    bottomPaddingPx.value = padding;
    void nextTick(() => {
      if (!disposed && currentMeasurement === measurement && shouldFollow && viewport.value === scroll && scroll.scrollTop === scrollTop) {
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' });
      }
    });
  }

  function observeElements() {
    transitions.clear();
    preserveReading = false;
    observer?.disconnect();
    if (viewport.value) {
      observer?.observe(viewport.value);
    }
    if (composer.value) {
      observer?.observe(composer.value);
    }
    if (editor.value) {
      observer?.observe(editor.value);
    }
    measure();
  }

  watch([composer, editor, viewport], observeElements, { flush: 'post' });
  watch([visibility, display], () => {
    void nextTick(measure);
  });
  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
    }
    observeElements();
    window.addEventListener('resize', measure);
  });
  onBeforeUnmount(() => {
    disposed = true;
    observer?.disconnect();
    window.removeEventListener('resize', measure);
  });

  return {
    bottomPaddingPx,
    availableSpace,
    measure,
    beginTransition,
    finishTransition,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
