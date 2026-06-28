<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed } from 'vue';
import type { ApprovalActionId, ApprovalActiveRequest, ApprovalUiDecision } from '@/services/approval';
import ChatApprovalDecisionList from './ChatApprovalDecisionList.vue';
import ChatApprovalPreviewRenderer from './ChatApprovalPreviewRenderer';

const props = defineProps<{
  request: ApprovalActiveRequest,
}>();

const actionLabel = computed(() => resolveActionLabel({ actionId: props.request.action.id }));

function resolveActionLabel({ actionId }: { actionId: ApprovalActionId }): string | undefined {
  switch (actionId) {
  case 'tool.wikipedia.search':
    return lazyStrings.chatApproval__search_wikipedia();
  case 'tool.wikipedia.get_page':
    return lazyStrings.chatApproval__get_wikipedia_page();
  default: {
    const _exhaustive: never = actionId;
    throw new Error(`Unhandled approval action: ${_exhaustive}`);
  }
  }
}

const approvalTitle = computed(() => {
  if (actionLabel.value === undefined) return undefined;
  return lazyStrings.chatApproval__allow_action({ actionLabel: actionLabel.value });
});

const emit = defineEmits<{
  (event: 'decide', decision: ApprovalUiDecision): void,
}>();

function decide({
  decision,
}: {
  decision: ApprovalUiDecision,
}): void {
  emit('decide', decision);
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  },
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
          {{ approvalTitle }}
        </div>
      </div>

      <div
        v-if="props.request.preview !== undefined"
        class="rounded-xl border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40"
      >
        <ChatApprovalPreviewRenderer :preview="props.request.preview" />
      </div>

      <ChatApprovalDecisionList
        v-if="actionLabel !== undefined"
        :action-label="actionLabel"
        @decide="decision => decide({ decision })"
      />
    </div>
  </div>
</template>
