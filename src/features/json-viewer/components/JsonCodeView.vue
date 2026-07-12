<script setup lang="ts">
import { computed } from 'vue';
import {
  formatJsonSource,
  tokenizeJson,
  type JsonSyntaxToken,
} from '@/features/json-viewer/logic/json-syntax';

const props = defineProps<{
  source: string,
  displayMode: 'raw' | 'formatted',
  overflowMode: 'scroll' | 'wrap',
  heightMode: 'content' | 'fill',
}>();

const presentation = computed(() => {
  const formatted = formatJsonSource({ source: props.source });
  switch (props.displayMode) {
  case 'formatted':
    return formatted;
  case 'raw':
    return { text: props.source, status: formatted.status };
  default: {
    const _ex: never = props.displayMode;
    throw new Error(`Unhandled JSON display mode: ${String(_ex)}`);
  }
  }
});
const tokens = computed<readonly JsonSyntaxToken[]>(() => tokenizeJson({
  source: presentation.value.text,
}));


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div
    data-testid="json-code-view"
    :tw-class="[
      'relative min-h-0 min-w-0',
      heightMode === 'fill' ? 'flex h-full flex-col' : '',
    ]"
  >
    <div
      v-if="presentation.status === 'invalid'"
      data-testid="json-code-view-invalid"
      tw-class="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200"
    >
      The persisted text is not valid JSON. Showing the original text without reformatting.
    </div>
    <pre
      class="json-code-view"
      :class="{ 'json-code-view--wrap': overflowMode === 'wrap' }"
      :tw-class="[
        'm-0 overflow-auto p-4 font-mono text-[11px] leading-5',
        heightMode === 'fill' ? 'min-h-0 flex-1' : 'min-h-[240px]',
      ]"
    ><code><span
      v-for="(token, index) in tokens"
      :key="index"
      :class="`json-syntax-${token.type}`"
    >{{ token.text }}</span></code></pre>
  </div>
</template>

<style scoped>
.json-code-view {
  color: rgb(31 41 55);
  tab-size: 2;
  white-space: pre;
}

.json-code-view--wrap {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.json-syntax-property {
  color: rgb(37 99 235);
}

.json-syntax-string {
  color: rgb(5 150 105);
}

.json-syntax-number {
  color: rgb(147 51 234);
}

.json-syntax-boolean,
.json-syntax-null {
  color: rgb(217 119 6);
  font-weight: 600;
}

.json-syntax-punctuation {
  color: rgb(107 114 128);
}

.json-syntax-invalid {
  background: rgb(254 226 226);
  color: rgb(185 28 28);
  text-decoration: underline wavy;
}

:global(.dark) .json-code-view {
  color: rgb(229 231 235);
}

:global(.dark) .json-syntax-property {
  color: rgb(96 165 250);
}

:global(.dark) .json-syntax-string {
  color: rgb(52 211 153);
}

:global(.dark) .json-syntax-number {
  color: rgb(192 132 252);
}

:global(.dark) .json-syntax-boolean,
:global(.dark) .json-syntax-null {
  color: rgb(251 191 36);
}

:global(.dark) .json-syntax-punctuation {
  color: rgb(156 163 175);
}

:global(.dark) .json-syntax-invalid {
  background: rgb(69 10 10);
  color: rgb(252 165 165);
}
</style>
