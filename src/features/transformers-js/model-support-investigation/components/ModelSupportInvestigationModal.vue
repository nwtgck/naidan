<script setup lang="ts">
import { shallowRef } from 'vue';
import ModelSupportInvestigationSession from './ModelSupportInvestigationSession.vue';
import { normalizeInvestigationTarget } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import { createInvestigationSessionView, recallInvestigationSession, type InvestigationSessionSnapshot } from '@/features/transformers-js/model-support-investigation/logic/investigation-session';

const props = defineProps<{ modelId: string }>();
const emit = defineEmits<{ (event: 'close'): void }>();
const sessionView = shallowRef(createInvestigationSessionView({
  initialSnapshot: recallInvestigationSession({ seededTarget: normalizeInvestigationTarget({ input: props.modelId }) }),
}));

function replaceSession({ viewId, snapshot }: {
  viewId: string;
  snapshot: Extract<InvestigationSessionSnapshot, { view: 'setup' }>;
}): void {
  if (sessionView.value.viewId !== viewId || sessionView.value.isActive()) return;
  const replacement = createInvestigationSessionView({ initialSnapshot: snapshot });
  replacement.remember({ snapshot });
  sessionView.value = replacement;
}

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
  <ModelSupportInvestigationSession
    :key="sessionView.viewId"
    :model-id="props.modelId"
    :session-view="sessionView"
    @close="emit('close')"
    @new-investigation="replaceSession"
  />
</template>
