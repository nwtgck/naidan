<script setup lang="ts">
import { computed, watch } from 'vue';
import { Volume2, Pause, Square, RotateCcw } from 'lucide-vue-next';
import { webSpeechService } from '../services/web-speech';
import { isImageGenerationPending, isImageGenerationProcessed } from '../utils/image-generation';

const props = defineProps<{
  messageId: string;
  content: string;
  showFullControls?: boolean;
}>();

const isSupported = webSpeechService.isSupported();
const isThisMessageActive = computed(() => webSpeechService.state.activeMessageId === props.messageId);
const isPlaying = computed(() => isThisMessageActive.value && webSpeechService.state.status === 'playing');
const isPaused = computed(() => isThisMessageActive.value && webSpeechService.state.status === 'paused');
const isSpeechActive = computed(() => isThisMessageActive.value && webSpeechService.state.status !== 'inactive');

const isHidden = computed(() => {
  return isImageGenerationProcessed(props.content) || isImageGenerationPending(props.content);
});

function handleToggleSpeech() {
  if (isPlaying.value) {
    webSpeechService.pause();
  } else {
    webSpeechService.speak({ text: props.content, messageId: props.messageId });
  }
}

function handleStopSpeech() {
  webSpeechService.stop();
}

function handleRestartSpeech() {
  webSpeechService.speak({ text: props.content, messageId: props.messageId });
}

// Watch for content updates during streaming
watch(() => props.content, (newContent) => {
  if (isPlaying.value) {
    webSpeechService.speak({
      text: newContent,
      messageId: props.messageId,
      isFinal: false
    });
  }
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div v-if="isSupported && !isHidden" class="flex items-center" :class="{ 'gap-1': isSpeechActive && showFullControls }">
    <!-- Flat Toggle Button (Shown when inactive OR when full controls are not requested) -->
    <button
      v-if="!isSpeechActive || !showFullControls"
      @click.stop="handleToggleSpeech"
      class="rounded-lg transition-colors p-1"
      :class="[
        isSpeechActive
          ? 'text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-800/50'
      ]"
      :title="isPaused ? 'Resume reading' : (isPlaying ? 'Pause reading' : 'Read aloud')"
      data-testid="speech-toggle-mini"
    >
      <Pause v-if="isPlaying" class="w-3 h-3" />
      <Volume2 v-else class="w-3 h-3" />
    </button>

    <!-- Expanded Control Panel (Only when active AND full controls are requested) -->
    <div
      v-else
      class="flex items-center gap-0.5 bg-blue-50/50 dark:bg-blue-900/20 rounded-lg border border-blue-100/50 dark:border-blue-800/30 p-0.5 animate-in fade-in zoom-in-95 duration-200"
      @click.stop
    >
      <button
        @click="handleRestartSpeech"
        class="p-1.5 text-blue-600/60 dark:text-blue-400/60 hover:text-blue-600 dark:hover:text-blue-400 rounded-md transition-colors"
        title="Restart from beginning"
        data-testid="speech-restart-button"
      >
        <RotateCcw class="w-3 h-3" />
      </button>
      <button
        @click="handleStopSpeech"
        class="p-1.5 text-blue-600/60 dark:text-blue-400/60 hover:text-red-500 dark:hover:text-red-400 rounded-md transition-colors"
        title="Stop reading"
        data-testid="speech-stop-button"
      >
        <Square class="w-3 h-3" />
      </button>
      <button
        @click="handleToggleSpeech"
        class="p-1.5 rounded-md transition-colors text-blue-600 dark:text-blue-400 hover:bg-blue-100/50 dark:hover:bg-blue-800/50"
        :title="isPaused ? 'Resume reading' : 'Pause reading'"
        data-testid="speech-toggle-button"
      >
        <Pause v-if="isPlaying" class="w-3.5 h-3.5" />
        <Volume2 v-else class="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
</template>
