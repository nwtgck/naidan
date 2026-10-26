<script setup lang="ts">
import { computed } from 'vue';
import { useCspMessageHintsOnly } from '@/composables/useCspMessageHintsOnly';
import type { CspHintTarget } from '@/logic/csp-message-hints/types';
import CspMessageHintView from './CspMessageHintView.vue';
import { describeCspHintForDisplayOnly } from './hint-copy';
import type { CspHintActivityForDisplayOnly } from './types';

const props = defineProps<{ target: CspHintTarget | undefined, presentation: 'compact' | 'error' | 'error-details', activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined }>();

function hasRecognizableHostForMessagesOnly({ url }: { url: URL }): boolean {
  // Single-label hosts such as `myhost` are valid, but while typing they are
  // indistinguishable from the beginning of localhost or a domain name.
  // Accept that preflight omission; real errors still receive their own hints.
  const hostname = url.hostname;
  return hostname.includes('.') || hostname === 'localhost' || hostname.includes(':');
}

const targetForMessagesOnly = computed(() => {
  const target = props.target;
  const presentation = props.presentation;
  switch (presentation) {
  case 'error': case 'error-details': return target;
  case 'compact': break;
  default: {
    const exhaustive: never = presentation;
    throw new Error(`Unhandled CSP display presentation: ${String(exhaustive)}`);
  }
  }
  if (target === undefined) {
    return undefined;
  }
  // A partial scheme is not a destination. In particular, appending /models
  // to `https://` would invent the host `models`. Keep real error targets intact.
  switch (target.kind) {
  case 'connection': {
    const input = target.endpoint;
    if (input === undefined || input.length > 4_096) {
      return undefined;
    }
    const draft = input.trim().toLowerCase();
    if ('http://'.startsWith(draft) || 'https://'.startsWith(draft) || /^(?:https?:)?\/{2,}$/.test(draft)) {
      return undefined;
    }
    if (/^https?:/.test(draft) || draft.startsWith('//')) {
      try {
        const url = new URL(draft.startsWith('//') ? `https:${draft}` : draft);
        if (!hasRecognizableHostForMessagesOnly({ url })) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return target;
  }
  case 'relay': {
    // RPC transport requires an absolute HTTP(S) URL. Do not turn its draft
    // into an unrelated same-site URL by resolving it against this document.
    try {
      if (target.url === undefined || target.url.length > 4_096) {
        return undefined;
      }
      if (!/^https?:\/\//i.test(target.url.trim())) {
        return undefined;
      }
      const url = new URL(target.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
      }
      if (!hasRecognizableHostForMessagesOnly({ url })) {
        return undefined;
      }
      return target;
    } catch {
      return undefined;
    }
  }
  case 'wikipedia':
  case 'huggingface-metadata':
  case 'onboarding-v2-huggingface-access':
  case 'huggingface-download':
  case 'resource':
  case 'resource-list': return target;
  default: {
    const exhaustive: never = target;
    throw new Error(`Unhandled CSP display target: ${String(exhaustive)}`);
  }
  }
});
const message = useCspMessageHintsOnly({ target: targetForMessagesOnly });
const copy = computed(() => {
  const presentation = props.presentation;
  switch (presentation) {
  case 'compact': return describeCspHintForDisplayOnly({ message: message.value, target: targetForMessagesOnly.value, activityForDisplayOnly: props.activityForDisplayOnly, presentation: 'compact' });
  case 'error': case 'error-details': return describeCspHintForDisplayOnly({ message: message.value, target: targetForMessagesOnly.value, activityForDisplayOnly: props.activityForDisplayOnly, presentation: 'error' });
  default: {
    const exhaustive: never = presentation;
    throw new Error(`Unhandled CSP display presentation: ${String(exhaustive)}`);
  }
  }
});


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
  <CspMessageHintView v-if="copy !== undefined" :copy="copy" :presentation="presentation" />
</template>
