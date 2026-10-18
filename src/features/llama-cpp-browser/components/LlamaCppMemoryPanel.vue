<script setup lang="ts">
import { memoryDiagnosticsHistories } from '@/features/llama-cpp-browser/memory-diagnostics-store';
import { lazyStrings } from '@/strings';
import { ActivityIcon } from 'lucide-vue-next';

function formatCapacity({ bytes }: { bytes: number }): string {
  return `${(bytes / 1048576).toFixed(2)} MiB (${bytes.toLocaleString()} B)`;
}

function formatTimestamp({ timestamp }: { timestamp: number }): string {
  return new Date(timestamp).toLocaleTimeString();
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
  <div tw-class="space-y-3 text-xs leading-5 text-gray-600 dark:text-gray-300" data-testid="llama-memory-panel">
    <h3 tw-class="text-sm font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppMemoryPanel__linear_memory_capacity() }}</h3>
    <p tw-class="max-w-4xl text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppMemoryPanel__observation_note() }}</p>
    <div v-if="memoryDiagnosticsHistories.length === 0" tw-class="flex flex-col items-center justify-center gap-3 px-4 py-6 text-center text-gray-500 dark:text-gray-400" data-testid="llama-memory-empty">
      <div tw-class="p-2.5 rounded-xl bg-gray-100 dark:bg-gray-800/70">
        <ActivityIcon tw-class="w-5 h-5 text-gray-400 dark:text-gray-500" />
      </div>
      <p>{{ lazyStrings.LlamaCppMemoryPanel__no_samples() }}</p>
    </div>
    <section v-for="history in [...memoryDiagnosticsHistories].reverse()" :key="`${history.workerId}:${history.instanceId}`" tw-class="border border-gray-200 dark:border-gray-700/70 bg-white dark:bg-gray-800/30 rounded-xl p-3 space-y-2" data-testid="llama-memory-history">
      <p tw-class="font-mono font-medium text-gray-800 dark:text-gray-100 break-all">{{ history.profile }} · {{ history.instanceId }}</p>
      <p tw-class="inline-flex rounded-md bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{{ history.status === 'observed' ? lazyStrings.LlamaCppMemoryPanel__active_history() : lazyStrings.LlamaCppMemoryPanel__ended_history() }}</p>
      <p tw-class="tabular-nums">{{ lazyStrings.LlamaCppMemoryPanel__last_sample() }}: {{ formatCapacity({ bytes: history.samples[history.samples.length - 1]!.capacityBytes }) }}</p>
      <p tw-class="tabular-nums">{{ lazyStrings.LlamaCppMemoryPanel__observed_maximum() }}: {{ formatCapacity({ bytes: history.observedMaximumBytes }) }}</p>
      <p v-if="history.latestLoad" tw-class="tabular-nums">{{ lazyStrings.LlamaCppMemoryPanel__change_since_latest_load_started() }} #{{ history.latestLoad.ordinal }}: {{ formatCapacity({ bytes: history.samples[history.samples.length - 1]!.capacityBytes - history.latestLoad.baselineBytes }) }}</p>
      <template v-if="history.samples[history.samples.length - 1]!.gpuRequests">
        <p tw-class="text-[11px] text-gray-500 dark:text-gray-400" data-testid="gpu-request-note">{{ lazyStrings.LlamaCppMemoryPanel__gpu_request_note() }}</p>
        <p v-if="history.latestLoad?.gpuRequests" tw-class="tabular-nums" data-testid="gpu-request-load-delta">{{ lazyStrings.LlamaCppMemoryPanel__gpu_requests_since_load_started({
          bufferBytes: formatCapacity({ bytes: history.samples[history.samples.length - 1]!.gpuRequests!.bufferBytes - history.latestLoad.gpuRequests.bufferBytes }),
          bufferCount: history.samples[history.samples.length - 1]!.gpuRequests!.bufferCount - history.latestLoad.gpuRequests.bufferCount,
          writeBytes: formatCapacity({ bytes: history.samples[history.samples.length - 1]!.gpuRequests!.writeBytes - history.latestLoad.gpuRequests.writeBytes }),
          writeCount: history.samples[history.samples.length - 1]!.gpuRequests!.writeCount - history.latestLoad.gpuRequests.writeCount,
        }) }}</p>
      </template>
      <ol tw-class="font-mono text-[11px] leading-5 tabular-nums border-t border-gray-200/80 dark:border-gray-700/60 pt-1 divide-y divide-gray-100 dark:divide-gray-700/40">
        <li v-for="(sample, index) in [...history.samples].reverse()" :key="index" tw-class="py-2 break-words">{{ formatTimestamp({ timestamp: sample.timestamp }) }} · {{ sample.checkpoint }} · {{ formatCapacity({ bytes: sample.capacityBytes }) }}
          <p v-if="sample.gpuRequests" tw-class="mt-1 text-gray-500 dark:text-gray-400" data-testid="gpu-request-sample">{{ lazyStrings.LlamaCppMemoryPanel__gpu_request_totals({
            bufferBytes: formatCapacity({ bytes: sample.gpuRequests.bufferBytes }), bufferCount: sample.gpuRequests.bufferCount,
            writeBytes: formatCapacity({ bytes: sample.gpuRequests.writeBytes }), writeCount: sample.gpuRequests.writeCount,
            largestWrite: formatCapacity({ bytes: sample.gpuRequests.largestWriteBytes }), largeWrites: sample.gpuRequests.writesAtLeast4MiB,
          }) }}</p>
        </li>
      </ol>
    </section>
  </div>
</template>
