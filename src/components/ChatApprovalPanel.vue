<script setup lang="ts">
import type { ApprovalActiveRequest, ApprovalUiDecision } from '@/services/approval';

const props = defineProps<{
  request: ApprovalActiveRequest;
}>();

const emit = defineEmits<{
  (e: 'decide', decision: ApprovalUiDecision): void;
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
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-[11px] font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Approval required
          </div>
          <div class="mt-0.5 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {{ props.request.action.label }}
          </div>
        </div>
      </div>

      <div
        v-if="props.request.preview !== undefined"
        class="rounded-xl border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40"
      >
        <div class="flex flex-col gap-2">
          <div
            v-for="line in props.request.preview.lines"
            :key="line.label"
            class="min-w-0"
          >
            <div class="text-[11px] font-medium text-gray-500 dark:text-gray-400">
              {{ line.label }}
            </div>
            <div class="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">
              {{ line.value }}
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="approval-allow-once"
          @click="decide({ decision: 'allow_once' })"
        >
          Allow once
        </button>
        <button
          type="button"
          class="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="approval-allow-for-chat"
          @click="decide({ decision: 'allow_for_chat' })"
        >
          Allow for this chat
        </button>
        <button
          type="button"
          class="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="approval-allow-globally"
          title="Applies across chats until reload."
          @click="decide({ decision: 'allow_globally' })"
        >
          Allow globally
        </button>
        <button
          type="button"
          class="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-red-900/70 dark:hover:bg-red-950/30 dark:hover:text-red-300"
          data-testid="approval-deny"
          @click="decide({ decision: 'deny' })"
        >
          Deny
        </button>
      </div>
    </div>
  </div>
</template>
