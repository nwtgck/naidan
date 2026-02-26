<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { Brain } from 'lucide-vue-next';
import type { MessageNode } from '../models/types';

const props = defineProps<{
  message: MessageNode;
}>();

type ThinkingMode = 'expanded' | 'collapsed-active' | 'collapsed-finished';

const isUserExpanded = ref(false);
const thinkingContentRef = ref<HTMLElement | null>(null);

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

const mode = computed<ThinkingMode>(() => {
  if (isUserExpanded.value) return 'expanded';
  return isThinkingNow.value ? 'collapsed-active' : 'collapsed-finished';
});

function handleToggleThinking() {
  if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
  isUserExpanded.value = !isUserExpanded.value;
}

// Auto-scroll to bottom during active thinking
watch(displayThinking, async () => {
  const currentMode = mode.value;
  switch (currentMode) {
  case 'collapsed-active':
    await nextTick();
    if (thinkingContentRef.value) {
      thinkingContentRef.value.scrollTop = thinkingContentRef.value.scrollHeight;
    }
    break;
  case 'expanded':
  case 'collapsed-finished':
    break;
  default: {
    const _ex: never = currentMode;
    return _ex;
  }
  }
});

defineExpose({
  __testOnly: {
    isUserExpanded,
    mode,
    handleToggleThinking
  }
});
</script>

<template>
  <!-- Thinking Block -->
  <div v-if="hasThinking" class="mb-3" data-testid="thinking-block">
    <div
      class="transition-all duration-500 ease-in-out relative group/thinking w-full"
      :class="[
        /* Shape & Size */
        mode === 'expanded' ? 'p-5 rounded-2xl min-h-[100px]' : '',
        mode === 'collapsed-active' ? 'p-4 rounded-xl max-h-32 overflow-hidden' : '',
        mode === 'collapsed-finished' ? 'px-3 py-1.5 rounded-xl' : '',

        'cursor-pointer',

        /* State: Active Thinking */
        isThinkingNow
          ? 'overflow-visible'
          : 'border shadow-sm overflow-hidden',

        /* Background & Colors */
        mode === 'expanded' || mode === 'collapsed-active'
          ? 'bg-gradient-to-br from-blue-50/50 to-sky-50/50 dark:from-blue-950/20 dark:to-sky-950/20 border-blue-100/50 dark:border-blue-800/30 shadow-inner'
          : 'bg-white dark:bg-gray-800/50 border-blue-100/50 dark:border-blue-800/30 hover:border-blue-200 dark:hover:border-blue-800'
      ]"
      @click="handleToggleThinking"
      data-testid="toggle-thinking"
    >
      <!-- Dedicated Thinking Border Element (Only when active) -->
      <div
        v-if="isThinkingNow"
        class="absolute inset-0 pointer-events-none thinking-gradient-border"
        style="border-radius: inherit;"
      ></div>

      <!-- Header / Button Content -->
      <div
        class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider relative z-20 transition-colors"
        :class="[
          mode === 'expanded' || mode === 'collapsed-active' ? 'mb-2 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 group-hover/thinking:text-blue-600',
          isThinkingNow ? 'animate-pulse text-blue-700 dark:text-blue-400' : ''
        ]"
      >
        <Brain class="w-3.5 h-3.5" />
        <span v-if="isThinkingNow">Thinking...</span>
        <span v-else>{{ mode === 'expanded' ? 'Hide Thought Process' : 'Show Thought Process' }}</span>
      </div>

      <!-- Content Container -->
      <div
        ref="thinkingContentRef"
        v-if="mode === 'expanded' || mode === 'collapsed-active'"
        class="relative z-20 text-gray-600 dark:text-gray-400 text-[11px] font-mono whitespace-pre-wrap leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200 scroll-smooth"
        :class="[
          mode === 'collapsed-active' ? 'max-h-20 overflow-y-auto no-scrollbar mask-fade-top' : ''
        ]"
        data-testid="thinking-content"
      >
        <!-- Brain watermark -->
        <div class="absolute top-0 right-0 opacity-[0.03] dark:opacity-[0.07] pointer-events-none -mt-4">
          <Brain class="w-16 h-16" />
        </div>

        <div class="flex flex-col min-h-full">
          {{ displayThinking }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  padding: 1.2px;
  box-shadow: 0 0 20px -5px rgba(59, 130, 246, 0.4);
  background: conic-gradient(
    from var(--thinking-angle),
    #3b82f6 0%,
    #8b5cf6 10%,
    #06b6d4 20%,
    transparent 40%,
    transparent 100%
  );
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;
  animation: thinking-sweep 0.9s linear infinite;
  z-index: 10;
}

/* Fades the top of the content in collapsed-active mode to emphasize "newest at bottom" */
.mask-fade-top {
  mask-image: linear-gradient(to bottom, transparent, black 40%);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 40%);
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
