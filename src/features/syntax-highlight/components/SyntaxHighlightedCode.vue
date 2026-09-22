<script setup lang="ts">
import { onBeforeUnmount, shallowRef, triggerRef, watch } from 'vue';
import { createCodeEditSource } from '@/features/syntax-highlight/code-edit-source';
import { highlightSyntaxStream } from '@/features/syntax-highlight/stream';
import { createTokenDisplay } from '@/features/syntax-highlight/token-display';
import type { SyntaxLanguage, SyntaxToken } from '@/features/syntax-highlight/types';

const props = defineProps<{ code: string, language: SyntaxLanguage }>();
const tokens = shallowRef<SyntaxToken[]>([]);
type StreamOwner = { controller: AbortController, source: ReturnType<typeof createCodeEditSource>, state: 'active' | 'failed' };
let owner: StreamOwner | undefined;

function close() {
  owner?.controller.abort();
  owner?.source.close();
  owner = undefined;
}

watch(() => props.language, language => {
  close();
  const current: StreamOwner = { controller: new AbortController(), source: createCodeEditSource(), state: 'active' };
  owner = current;
  const display = createTokenDisplay();
  tokens.value = props.code.length === 0 ? [] : [{ kind: 'plain', text: props.code }];
  current.source.setCode({ code: props.code });
  void (async () => {
    try {
      for await (const edit of highlightSyntaxStream({ edits: current.source.edits, language, signal: current.controller.signal })) {
        if (owner !== current) return;
        display.apply({ edit });
        tokens.value = display.tokens;
        triggerRef(tokens);
      }
    } catch {
      // Highlighting failure must never hide or modify a tool's source text.
      if (owner === current) {
        current.state = 'failed';
        tokens.value = [{ kind: 'plain', text: props.code }];
      }
    } finally {
      current.source.close();
    }
  })();
}, { immediate: true });

watch(() => props.code, code => {
  if (!owner) return;
  switch (owner.state) {
  case 'active': owner.source.setCode({ code }); break;
  case 'failed': tokens.value = [{ kind: 'plain', text: code }]; break;
  default: {
    const _ex: never = owner.state;
    throw new Error(`Unhandled highlight state: ${_ex}`);
  }
  }
});
onBeforeUnmount(close);


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
  <!-- Interpolated text preserves source and escaping; the caller owns layout/wrapping. -->
  <code data-testid="syntax-highlighted-code"><span
    v-for="(token, index) in tokens"
    :key="index"
    :data-syntax="token.kind"
    :tw-class="{
      'text-purple-700 dark:text-purple-300': token.kind === 'keyword',
      'text-gray-600 dark:text-gray-400': token.kind === 'comment',
      'text-emerald-800 dark:text-emerald-300': token.kind === 'string',
      'text-amber-800 dark:text-amber-300': token.kind === 'variable',
      'text-gray-600 dark:text-gray-300': token.kind === 'operator',
      'text-blue-700 dark:text-blue-300': token.kind === 'command',
    }"
  >{{ token.text }}</span></code>
</template>
