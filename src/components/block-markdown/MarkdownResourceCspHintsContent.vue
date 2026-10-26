<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import { collectRenderedResourceHintInputs, type RenderedResourceHintInput } from './rendered-resource-hint-inputs';

const props = defineProps<{ element: Element | undefined, revision: string | number, presentation: 'compact' | 'error' }>();
const resources = shallowRef<readonly RenderedResourceHintInput[]>([]);
watch([() => props.element, () => props.revision], () => {
  resources.value = collectRenderedResourceHintInputs({ root: props.element });
}, { immediate: true, flush: 'post' });
const target = computed(() => resources.value.length === 0 ? undefined : { kind: 'resource-list' as const, resources: resources.value });


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
  <CspMessageHint :target="target" :presentation="presentation" :activity-for-display-only="undefined" />
</template>
