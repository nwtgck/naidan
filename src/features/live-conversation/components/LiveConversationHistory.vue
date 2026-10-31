<script setup lang="ts">
import { ref } from 'vue';
import { AudioLinesIcon, UserIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import LiveConversationImages from './LiveConversationImages.vue';
import type { LiveTurnView } from '@/features/live-conversation/logic/controller';
const props = defineProps<{ entries: LiveTurnView[], hideText: boolean }>();
const root = ref<HTMLElement>();
const emit = defineEmits<{ replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement], layout: [] }>();

function modelName({ modelId }: { modelId: string }): string {
  return modelId.split('/').at(-1) || modelId;
}

function pauseAudio(): void {
  root.value?.querySelectorAll('audio').forEach(audio => audio.pause());
}

function ended({ event }: { event: Event }): void {
  if (event.target instanceof HTMLAudioElement) {
    emit('replayEnd', event.target);
  }
}

function playing({ event }: { event: Event }): void {
  if (event.target instanceof HTMLAudioElement) {
    emit('replayStart', event.target);
  }
  root.value?.querySelectorAll('audio').forEach(audio => {
    if (audio !== event.target) {
      audio.pause();
    }
  });
}

defineExpose({ pauseAudio, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section ref="root" tw-class="min-w-0 space-y-8" :aria-label="lazyStrings.liveConversation__conversation()" data-testid="live-history">
    <article v-for="turn in props.entries" :key="turn.id" :tw-class="['space-y-5', { 'opacity-60': turn.status === 'discarded' }]" data-testid="live-turn">
      <div tw-class="ml-auto max-w-[92%] space-y-2 rounded-2xl rounded-tr-sm bg-gray-100/80 p-4 sm:max-w-[85%] dark:bg-gray-800/60">
        <h2 tw-class="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-gray-400"><UserIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__you() }}</h2>
        <p v-if="turn.inputText" tw-class="whitespace-pre-wrap break-words text-sm leading-6">{{ turn.inputText }}</p>
        <p v-if="turn.hasAudio" tw-class="flex items-center gap-2 break-all text-xs text-gray-500 dark:text-gray-400"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ turn.audioSource?.kind === 'file' ? turn.audioSource.name : lazyStrings.liveConversation__voice_message() }}</p>
        <LiveConversationImages :images="turn.images" @layout="emit('layout')" />
        <audio v-if="turn.inputAudio" :src="turn.inputAudio.url" controls preload="none" @play="playing({ event: $event })" @pause="ended({ event: $event })" @ended="ended({ event: $event })" :aria-label="lazyStrings.liveConversation__audio_sent_to_model()" tw-class="h-10 w-full" data-testid="live-input-replay" />
        <p v-if="turn.transcript" tw-class="whitespace-pre-wrap break-words text-sm leading-6" data-testid="live-input-transcript">{{ turn.transcript }}</p>
        <details v-if="turn.inputStatistics" tw-class="text-xs text-gray-500 dark:text-gray-400">
          <summary tw-class="cursor-pointer">{{ lazyStrings.liveConversation__audio_details() }}</summary>
          <p tw-class="mt-2 break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: turn.inputStatistics.seconds.toFixed(2), sampleRate: turn.inputStatistics.sampleRate, peak: turn.inputStatistics.peak.toFixed(4), rms: turn.inputStatistics.rms.toFixed(4), clipped: turn.inputStatistics.clippedSamples }) }}</p>
          <p tw-class="mt-1 leading-5">{{ lazyStrings.liveConversation__audio_details_help() }}</p>
        </details>
      </div>
      <div tw-class="space-y-3 pr-4 sm:pr-10">
        <h2 :title="turn.modelId" tw-class="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span tw-class="min-w-0 break-all">{{ modelName({ modelId: turn.modelId }) }}</span></h2>
        <!-- Plain text is deliberate: tool/control fragments and external output
             are never interpreted as HTML or instructions. -->
        <p v-if="turn.answer && !hideText" tw-class="whitespace-pre-wrap break-words text-sm leading-7">{{ turn.answer }}</p>
        <p v-else-if="turn.output !== 'text'" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__voice_response() }}</p>
        <audio v-if="turn.outputAudio" :src="turn.outputAudio.url" controls preload="none" @play="playing({ event: $event })" @pause="ended({ event: $event })" @ended="ended({ event: $event })" :aria-label="lazyStrings.liveConversation__voice_response()" tw-class="h-10 w-full max-w-md" data-testid="live-output-replay" />
        <p v-if="turn.inputAudio?.status === 'partial' || turn.outputAudio?.status === 'partial'" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__partial_audio() }}</p>
        <details v-for="result in turn.toolResults" :key="result.id" tw-class="rounded-xl border border-gray-200 p-3 dark:border-gray-800"><summary tw-class="cursor-pointer text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__shell_in_browser() }}</summary><pre tw-class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{{ result.command }}{{ '\n' }}{{ result.result }}</pre></details>
        <p v-if="turn.status === 'discarded'" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__discarded() }}</p>
        <p v-if="turn.status === 'limit'" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__limit() }}</p>
      </div>
    </article>
  </section>
</template>
