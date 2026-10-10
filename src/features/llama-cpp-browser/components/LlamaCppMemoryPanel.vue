<script setup lang="ts">
import { memoryDiagnosticsHistories } from '@/features/llama-cpp-browser/memory-diagnostics-store';
import { lazyStrings } from '@/strings';

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
  <div tw-class="space-y-3 text-xs" data-testid="llama-memory-panel">
    <h3 tw-class="font-bold">{{ lazyStrings.LlamaCppMemoryPanel__linear_memory_capacity() }}</h3>
    <p tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppMemoryPanel__observation_note() }}</p>
    <p v-if="memoryDiagnosticsHistories.length === 0" data-testid="llama-memory-empty">{{ lazyStrings.LlamaCppMemoryPanel__no_samples() }}</p>
    <section v-for="history in [...memoryDiagnosticsHistories].reverse()" :key="`${history.workerId}:${history.instanceId}`" tw-class="border border-gray-200 dark:border-gray-700 rounded p-2 space-y-1" data-testid="llama-memory-history">
      <p tw-class="font-mono">{{ history.profile }} · {{ history.instanceId }}</p>
      <p>{{ history.status === 'observed' ? lazyStrings.LlamaCppMemoryPanel__active_history() : lazyStrings.LlamaCppMemoryPanel__ended_history() }}</p>
      <p>{{ lazyStrings.LlamaCppMemoryPanel__last_sample() }}: {{ formatCapacity({ bytes: history.samples[history.samples.length - 1]!.capacityBytes }) }}</p>
      <p>{{ lazyStrings.LlamaCppMemoryPanel__observed_maximum() }}: {{ formatCapacity({ bytes: history.observedMaximumBytes }) }}</p>
      <p v-if="history.latestLoad">{{ lazyStrings.LlamaCppMemoryPanel__change_since_latest_load_started() }} #{{ history.latestLoad.ordinal }}: {{ formatCapacity({ bytes: history.samples[history.samples.length - 1]!.capacityBytes - history.latestLoad.baselineBytes }) }}</p>
      <template v-if="history.samples[history.samples.length - 1]!.gpuRequests">
        <p data-testid="gpu-request-note">{{ lazyStrings.LlamaCppMemoryPanel__gpu_request_note() }}</p>
        <p v-if="history.latestLoad?.gpuRequests" data-testid="gpu-request-load-delta">{{ lazyStrings.LlamaCppMemoryPanel__gpu_requests_since_load_started({
          bufferBytes: formatCapacity({ bytes: history.samples[history.samples.length - 1]!.gpuRequests!.bufferBytes - history.latestLoad.gpuRequests.bufferBytes }),
          bufferCount: history.samples[history.samples.length - 1]!.gpuRequests!.bufferCount - history.latestLoad.gpuRequests.bufferCount,
          writeBytes: formatCapacity({ bytes: history.samples[history.samples.length - 1]!.gpuRequests!.writeBytes - history.latestLoad.gpuRequests.writeBytes }),
          writeCount: history.samples[history.samples.length - 1]!.gpuRequests!.writeCount - history.latestLoad.gpuRequests.writeCount,
        }) }}</p>
      </template>
      <ol tw-class="font-mono space-y-1">
        <li v-for="(sample, index) in [...history.samples].reverse()" :key="index">{{ formatTimestamp({ timestamp: sample.timestamp }) }} · {{ sample.checkpoint }} · {{ formatCapacity({ bytes: sample.capacityBytes }) }}
          <p v-if="sample.gpuRequests" data-testid="gpu-request-sample">{{ lazyStrings.LlamaCppMemoryPanel__gpu_request_totals({
            bufferBytes: formatCapacity({ bytes: sample.gpuRequests.bufferBytes }), bufferCount: sample.gpuRequests.bufferCount,
            writeBytes: formatCapacity({ bytes: sample.gpuRequests.writeBytes }), writeCount: sample.gpuRequests.writeCount,
            largestWrite: formatCapacity({ bytes: sample.gpuRequests.largestWriteBytes }), largeWrites: sample.gpuRequests.writesAtLeast4MiB,
          }) }}</p>
        </li>
      </ol>
    </section>
  </div>
</template>
