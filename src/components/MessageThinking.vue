<script setup lang="ts">
import { computed, ref } from 'vue';
import { Brain } from 'lucide-vue-next';
import type { MessageNode } from '../models/types';

const props = defineProps<{
  message: MessageNode;
}>();

const showThinking = ref(false); // Default to collapsed

const displayThinking = computed(() => {
  if (props.message.thinking) return props.message.thinking;

  // Try to extract from content if not yet processed (streaming case)
  const matches = [...props.message.content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)];
  if (matches.length === 0) return '';

  return matches.map(m => m[1]?.trim()).filter(Boolean).join('\n\n---\n\n');
});

const hasThinking = computed(() => !!props.message.thinking || /<think>/i.test(props.message.content));
const isThinkingNow = computed(() => {
  if (props.message.thinking) return false; // Already processed
  const content = props.message.content;
  const lastOpen = content.lastIndexOf('<think>');
  const lastClose = content.lastIndexOf('</think>');
  return lastOpen > -1 && lastClose < lastOpen;
});

function handleToggleThinking() {
  if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
  showThinking.value = !showThinking.value;
}



defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- TEMPLATE_START -->
  <!-- Thinking Block -->
  <div v-if="hasThinking" class="mb-3" data-testid="thinking-block">
    <div
      class="transition-all duration-300 ease-in-out relative group/thinking"
      :class="[
        /* Shape & Size */
        showThinking ? 'w-full p-5 rounded-2xl' : 'inline-flex items-center w-auto px-3 py-1.5 rounded-xl cursor-pointer',

        /* State: Active Thinking */
        /* We remove 'border' and 'shadow' from parent when thinking to avoid artifacts.
               The child div handles the border/glow. */
        isThinkingNow
          ? 'overflow-visible'
          : 'border shadow-sm overflow-hidden',

        /* Background & Colors (Normal State) */
        !isThinkingNow && showThinking
          ? 'bg-gradient-to-br from-blue-50/50 to-sky-50/50 dark:from-blue-950/20 dark:to-sky-950/20 border-blue-100/50 dark:border-blue-800/30 shadow-inner'
          : '',
        !isThinkingNow && !showThinking
          ? 'bg-white dark:bg-gray-800/50 border-blue-100/50 dark:border-blue-800/30 hover:border-blue-200 dark:hover:border-blue-800'
          : '',

        /* Background (Thinking State) - No borders here, handled by CSS */
        isThinkingNow && showThinking
          ? 'bg-gradient-to-br from-blue-50/50 to-sky-50/50 dark:from-blue-950/20 dark:to-sky-950/20 shadow-inner'
          : '',
        isThinkingNow && !showThinking
          ? 'bg-white dark:bg-gray-800/50'
          : ''
      ]"
      @click="handleToggleThinking"
      data-testid="toggle-thinking"
    >
      <!-- Dedicated Thinking Border Element -->
      <!-- Using style="border-radius: inherit" ensures we perfectly match the parent's rounded-xl/2xl state -->
      <div
        v-if="isThinkingNow"
        class="absolute inset-0 pointer-events-none thinking-gradient-border"
        style="border-radius: inherit;"
      ></div>

      <!-- Header / Button Content -->
      <div
        class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider relative z-20 transition-colors"
        :class="[
          showThinking ? 'mb-3 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 group-hover/thinking:text-blue-600',
          isThinkingNow ? 'animate-pulse text-blue-700 dark:text-blue-400' : ''
        ]"
      >
        <Brain class="w-3.5 h-3.5" />
        <span v-if="isThinkingNow">Thinking...</span>
        <span v-else>{{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}</span>
      </div>

      <!-- Expanded Content -->
      <div
        v-if="showThinking && displayThinking"
        class="relative z-20 text-gray-600 dark:text-gray-400 text-[11px] font-mono whitespace-pre-wrap leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200"
        data-testid="thinking-content"
      >
        <!-- Brain watermark -->
        <div class="absolute top-0 right-0 opacity-[0.03] dark:opacity-[0.07] pointer-events-none -mt-8">
          <Brain class="w-16 h-16" />
        </div>
        {{ displayThinking }}
      </div>
    </div>
  </div>
  <!-- TEMPLATE_END -->
</template>

<style scoped>
/* STYLE_START */
@property --thinking-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}

@keyframes thinking-sweep {
  0% {
    --thinking-angle: 0deg;
    opacity: 0;
  }
  2% {
    opacity: 1;
  }
  35% {
    --thinking-angle: 360deg;
    opacity: 1;
  }
  40% {
    opacity: 0;
  }
  100% {
    --thinking-angle: 360deg;
    opacity: 0;
  }
}

.thinking-gradient-border {
  /* Line thickness defined by padding */
  padding: 1.2px;

  /* Glow effect applied to this element (which matches the parent's shape via border-radius: inherit) */
  box-shadow: 0 0 20px -5px rgba(59, 130, 246, 0.4);

  /* Rotating gradient background */
  background: conic-gradient(
    from var(--thinking-angle),
    #3b82f6 0%,
    #8b5cf6 10%,
    #06b6d4 20%,
    transparent 40%,
    transparent 100%
  );

  /* MASKING: Cut out the content box, leaving only the padding area (border) */
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;

  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;

  /* Animation */
  animation: thinking-sweep 0.9s linear infinite;

  /* Sit behind content (z-10/20) but above parent background if transparent */
  z-index: 10;
}
/* STYLE_END */
</style>
