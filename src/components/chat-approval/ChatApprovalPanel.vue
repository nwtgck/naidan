<script setup lang="ts">
import type { ApprovalActiveRequest, ApprovalUiDecision } from '@/services/approval';
import ChatApprovalDecisionList from './ChatApprovalDecisionList.vue';
import ChatApprovalPreviewRenderer from './ChatApprovalPreviewRenderer';

const props = defineProps<{
  request: ApprovalActiveRequest;
}>();

const emit = defineEmits<{
  (event: 'decide', decision: ApprovalUiDecision): void;
}>();

function decide({
  decision,
}: {
  decision: ApprovalUiDecision;
}): void {
  emit('decide', decision);
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  }
});
</script>

<template>
  <div
    class="rounded-2xl border border-gray-100 bg-white p-3 shadow-lg ring-1 ring-black/5 dark:border-gray-700 dark:bg-gray-800 dark:ring-white/10"
    data-testid="chat-approval-panel"
  >
    <div class="flex flex-col gap-2.5">
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          Allow {{ props.request.action.label }}?
        </div>
      </div>

      <div
        v-if="props.request.preview !== undefined"
        class="rounded-xl border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40"
      >
        <ChatApprovalPreviewRenderer :preview="props.request.preview" />
      </div>

      <ChatApprovalDecisionList
        :action-label="props.request.action.label"
        @decide="decision => decide({ decision })"
      />
    </div>
  </div>
</template>
