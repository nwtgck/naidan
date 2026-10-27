<script setup lang="ts">
import { computed } from 'vue';
import type { CombinedToolCall } from '@/01-models/types';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';

const props = defineProps<{ toolCall: CombinedToolCall }>();
const target = computed(() => {
  const call = props.toolCall;
  if (call.call.function.name !== 'wikipedia_search' && call.call.function.name !== 'wikipedia_get_page') {
    return undefined;
  }
  const result = call.result;
  switch (result.status) {
  case 'executing':
  case 'success': return undefined;
  case 'error': break;
  default: {
    const exhaustive: never = result;
    void exhaustive;
    return undefined;
  }
  }
  switch (result.error.code) {
  case 'execution_failed':
  case 'timeout': return { kind: 'wikipedia' as const };
  case 'invalid_arguments':
  case 'other': return undefined;
  default: {
    const exhaustive: never = result.error.code;
    void exhaustive;
    return undefined;
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
  <CspMessageHint :target="target" presentation="error" activity-for-display-only="wikipedia" />
</template>
