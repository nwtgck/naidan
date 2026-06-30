<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, watch } from 'vue';
import { acquireSharedHighlightWorkerClient, releaseSharedHighlightWorkerClient } from '@/features/highlight/worker/client-shared';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { escapeTextAsHtml, sanitizeHighlightHtml } from '@/logic/security/allowedHtml';
import { CheckIcon, CopyIcon, TerminalIcon, WrapTextIcon } from 'lucide-vue-next';
import { useCodeBlockSettings } from '@/composables/useCodeBlockSettings';

const props = defineProps<{
  code: string,
  lang: string,
}>();

const { isLineWrapEnabled, toggleLineWrap } = useCodeBlockSettings();

const preRef = ref<HTMLElement | null>(null);
const scrollState = ref({ top: 0, left: 0 });
const renderedCodeHtml = ref(escapeTextAsHtml({
  text: props.code,
}));
let latestHighlightRequestId = 0;
let isDisposed = false;
let highlightWorkerClientPromise: ReturnType<typeof acquireSharedHighlightWorkerClient> | undefined;

async function syncHighlightedCodeFromWorker({
  code,
  lang,
}: {
  code: string,
  lang: string,
}): Promise<void> {
  const requestId = ++latestHighlightRequestId;

  try {
    highlightWorkerClientPromise ??= acquireSharedHighlightWorkerClient();
    const client = await highlightWorkerClientPromise;
    const response = await client.highlight({
      request: {
        code,
        language: lang || undefined,
        mode: 'named-language',
      },
    });

    if (isDisposed || requestId !== latestHighlightRequestId) {
      return;
    }

    renderedCodeHtml.value = sanitizeHighlightHtml({ html: response.html });
  } catch (error) {
    if (isDisposed || requestId !== latestHighlightRequestId) {
      return;
    }

    console.error('Failed to highlight code in worker:', error);
    renderedCodeHtml.value = escapeTextAsHtml({
      text: code,
    });
  }
}

// Scroll preservation logic
onBeforeUpdate(() => {
  if (preRef.value) {
    scrollState.value = {
      top: preRef.value.scrollTop,
      left: preRef.value.scrollLeft,
    };
  }
});

onUpdated(() => {
  if (preRef.value) {
    preRef.value.scrollTop = scrollState.value.top;
    preRef.value.scrollLeft = scrollState.value.left;
  }
});

onMounted(() => {
  highlightWorkerClientPromise ??= acquireSharedHighlightWorkerClient();
  void syncHighlightedCodeFromWorker({
    code: props.code,
    lang: props.lang,
  });
});

watch(() => [props.code, props.lang] as const, async ([code, lang], [previousCode, previousLang]) => {
  if (code === previousCode && lang === previousLang) {
    return;
  }

  await syncHighlightedCodeFromWorker({ code, lang });
});

onBeforeUnmount(() => {
  isDisposed = true;
  latestHighlightRequestId += 1;
  highlightWorkerClientPromise = undefined;
  void releaseSharedHighlightWorkerClient();
});

const copied = ref(false);

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy code:', err);
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div class="code-block-wrapper my-4 rounded-lg overflow-hidden border border-gray-700/50 bg-[#0d1117] group/code shadow-sm">
    <div class="flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700/50 text-xs text-gray-400">
      <div class="flex items-center gap-2">
        <TerminalIcon class="w-3 h-3 opacity-50" />
        <span class="font-mono font-medium">{{ lang || 'text' }}</span>
      </div>
      <div class="flex items-center gap-2.5">
        <button
          @click="toggleLineWrap"
          class="flex items-center hover:text-white transition-colors cursor-pointer"
          :class="isLineWrapEnabled ? 'text-indigo-400' : 'text-gray-400'"
          :title="lazyStrings.blockMarkdown__toggle_line_wrap()"
        >
          <WrapTextIcon class="w-3.5 h-3.5" />
        </button>
        <button
          @click="copyCode"
          class="flex items-center hover:text-white transition-colors cursor-pointer"
          :class="copied ? 'text-green-400' : 'text-gray-400'"
          :title="copied ? lazyStrings.blockMarkdown__copied() : lazyStrings.blockMarkdown__copy_code()"
        >
          <CheckIcon v-if="copied" class="w-3.5 h-3.5" />
          <CopyIcon v-else class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
    <pre
      ref="preRef"
      class="!m-0 !p-4 !bg-transparent scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent"
      :class="isLineWrapEnabled ? 'whitespace-pre-wrap break-words overflow-x-hidden' : 'whitespace-pre overflow-x-auto'"
    ><AllowedHtmlView
      as="code"
      :html="renderedCodeHtml"
      class="!bg-transparent !p-0 !border-none !text-sm font-mono leading-relaxed !text-gray-200"
    /></pre>
  </div>
</template>
