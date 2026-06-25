<script setup lang="ts">
import type { ApprovalUiDecision } from '@/services/approval';

const props = defineProps<{
  actionLabel: string,
}>();

const emit = defineEmits<{
  (event: 'decide', decision: ApprovalUiDecision): void,
}>();

type ApprovalDecisionOption = {
  decision: ApprovalUiDecision,
  label: string,
  targetLabel: string | undefined,
  testId: string,
};

const options: ApprovalDecisionOption[] = [
  {
    decision: 'allow_once',
    label: 'Allow once',
    targetLabel: undefined,
    testId: 'approval-allow-once',
  },
  {
    decision: 'allow_for_chat',
    label: 'Allow for this chat',
    targetLabel: props.actionLabel,
    testId: 'approval-allow-for-chat',
  },
  {
    decision: 'allow_globally',
    label: 'Allow globally',
    targetLabel: props.actionLabel,
    testId: 'approval-allow-globally',
  },
  {
    decision: 'deny',
    label: 'Deny',
    targetLabel: undefined,
    testId: 'approval-deny',
  },
];

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
  <div class="grid gap-1.5">
    <button
      v-for="option in options"
      :key="option.decision"
      type="button"
      class="flex min-h-9 items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
      :class="{
        'hover:border-red-200 hover:bg-red-50 hover:text-red-700 dark:hover:border-red-900/70 dark:hover:bg-red-950/30 dark:hover:text-red-300': option.decision === 'deny',
      }"
      :data-testid="option.testId"
      @click="decide({ decision: option.decision })"
    >
      <span class="shrink-0">{{ option.label }}</span>
      <span
        v-if="option.targetLabel !== undefined"
        class="min-w-0 truncate text-[11px] font-medium text-gray-400 dark:text-gray-500"
      >
        {{ option.targetLabel }}
      </span>
    </button>
  </div>
</template>
