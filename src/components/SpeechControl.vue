<script setup lang="ts">
import { computed, watch } from 'vue';
import { Volume2, Pause, Square, RotateCcw } from 'lucide-vue-next';
import { webSpeechService } from '../services/web-speech';
import { isImageGenerationPending, isImageGenerationProcessed } from '../utils/image-generation';

const props = defineProps<{
  messageId: string;
  content: string;
  isGenerating?: boolean;
  showFullControls?: boolean;
}>();

const isSupported = webSpeechService.isSupported();
const isThisMessageActive = computed(() => webSpeechService.state.activeMessageId === props.messageId);
const isPlaying = computed(() => isThisMessageActive.value && (webSpeechService.state.status === 'playing' || webSpeechService.state.status === 'waiting'));
const isPaused = computed(() => isThisMessageActive.value && webSpeechService.state.status === 'paused');
const isSpeechActive = computed(() => isThisMessageActive.value && webSpeechService.state.status !== 'inactive');

const isHidden = computed(() => {
  return isImageGenerationProcessed(props.content) || isImageGenerationPending(props.content);
});

function handleToggleSpeech() {
  if (isPlaying.value && webSpeechService.state.status !== 'waiting') {
    webSpeechService.pause();
  } else {
    webSpeechService.speak({
      text: props.content,
      messageId: props.messageId,
      isFinal: !props.isGenerating,
      lang: webSpeechService.state.preferredLang
    });
  }
}

function handleStopSpeech() {
  webSpeechService.stop();
}

function handleRestartSpeech() {
  webSpeechService.speak({
    text: props.content,
    messageId: props.messageId,
    isFinal: !props.isGenerating,
    lang: webSpeechService.state.preferredLang
  });
}

// Watch for global language changes to restart if currently playing
watch(() => webSpeechService.state.preferredLang, () => {
  if (isSpeechActive.value) {
    handleRestartSpeech();
  }
});

// Watch for content updates during streaming
watch(() => props.content, (newContent) => {
  // Direct state check to be absolutely sure
  const state = webSpeechService.state;
  const isCurrentlyPlaying = state.status === 'playing' || state.status === 'waiting';
  const isThisActive = state.activeMessageId === props.messageId;

  if (isCurrentlyPlaying && isThisActive) {
    webSpeechService.speak({
      text: newContent,
      messageId: props.messageId,
      isFinal: false,
      lang: state.preferredLang
    });
  }
}, { immediate: false });

// Watch for generation completion to flush remaining text
watch(() => props.isGenerating, (isGenerating) => {
  const state = webSpeechService.state;
  const isCurrentlyPlaying = state.status === 'playing' || state.status === 'waiting';
  const isThisActive = state.activeMessageId === props.messageId;

  if (!isGenerating && isCurrentlyPlaying && isThisActive) {
    webSpeechService.speak({
      text: props.content,
      messageId: props.messageId,
      isFinal: true,
      lang: state.preferredLang
    });
  }
}, { immediate: false });


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div v-if="isSupported && !isHidden" class="flex items-center gap-0.5">
    <!-- Mini View (Header) -->
    <template v-if="!isSpeechActive || !showFullControls">
      <button
        @click.stop="handleToggleSpeech"
        class="p-1 rounded-lg text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 transition-colors"
        :title="isPaused ? 'Resume' : 'Read aloud'"
        data-testid="speech-toggle-mini"
      >

        <Pause v-if="isPlaying" class="w-3.5 h-3.5" />
        <Volume2 v-else class="w-3.5 h-3.5" />
      </button>
    </template>

    <!-- Full View (Footer) -->
    <template v-else>
      <button @click="handleRestartSpeech" class="p-1.5 text-blue-600/60 dark:text-blue-400/60 hover:text-blue-600 dark:hover:text-blue-400 rounded-md" title="Restart"><RotateCcw class="w-3.5 h-3.5" /></button>
      <button @click="handleStopSpeech" class="p-1.5 text-blue-600/60 dark:text-blue-400/60 hover:text-red-500 dark:hover:text-red-400 rounded-md" title="Stop"><Square class="w-3.5 h-3.5" /></button>
      <button @click="handleToggleSpeech" class="p-1.5 rounded-md transition-colors text-blue-600 dark:text-blue-400 hover:bg-blue-100/50 dark:hover:bg-blue-800/50" :title="isPaused ? 'Resume' : 'Pause'">
        <Pause v-if="isPlaying && webSpeechService.state.status !== 'waiting'" class="w-4 h-4" />
        <Volume2 v-else class="w-4 h-4" />
      </button>
    </template>
  </div>
</template>
