<script setup lang="ts">
const { text } = defineProps<{ text: string }>();
const characters = [...text].map((character, index, all) => ({ character, offset: `${(index * .6 / Math.max(all.length - 1, 1)).toFixed(3)}s` }));
const characterInterval = .6 / Math.max(characters.length - 1, 1);
const caretPace = characterInterval < .02 ? 'caret-fast' : characterInterval < .032 ? 'caret-medium' : 'caret-slow';

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <span class="typing-copy" :class="caretPace"><span class="sr-only">{{ text }}</span><span class="typing-text" aria-hidden="true"><span v-for="(item, index) in characters" :key="index" class="typing-character" :style="{ '--typing-offset': item.offset }">{{ item.character }}</span></span></span>
</template>

<style scoped>
.typing-text {
  animation: typing-input-mask 8s linear -3.5s infinite both;
}
.typing-character {
  position: relative;
  opacity: 0;
  animation: typing-character 8s linear calc(-3.5s + var(--typing-offset)) infinite both;
}
.typing-character::after {
  content: "";
  position: absolute;
  top: .08em;
  right: 0;
  width: 2px;
  height: 1em;
  background: currentColor;
  opacity: 0;
  visibility: hidden;
  animation: typing-caret-fast 8s linear calc(-3.5s + var(--typing-offset)) infinite both,typing-caret-blink .32s steps(1,end) -3.52s infinite;
}
.caret-medium .typing-character::after {
  animation-name: typing-caret-medium,typing-caret-blink;
}
.caret-slow .typing-character::after {
  animation-name: typing-caret-slow,typing-caret-blink;
}
.typing-character:last-child::after {
  animation-name: typing-caret-last,typing-caret-blink;
}
.typing-character:only-child::after {
  animation-name: typing-caret-only,typing-caret-blink;
}
@keyframes typing-input-mask {
  0%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
@keyframes typing-character {
  0%,.35% {
    opacity: 0;
  }
  .36%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
@keyframes typing-caret-fast {
  0%,.35%,100% {
    visibility: hidden;
  }
  .36%,.52% {
    visibility: visible;
  }
  .53% {
    visibility: hidden;
  }
}
@keyframes typing-caret-medium {
  0%,.35%,100% {
    visibility: hidden;
  }
  .36%,.66% {
    visibility: visible;
  }
  .67% {
    visibility: hidden;
  }
}
@keyframes typing-caret-slow {
  0%,.35%,100% {
    visibility: hidden;
  }
  .36%,.78% {
    visibility: visible;
  }
  .79% {
    visibility: hidden;
  }
}
@keyframes typing-caret-last {
  0%,.35%,100% {
    visibility: hidden;
  }
  .36%,1% {
    visibility: visible;
  }
  1.01% {
    visibility: hidden;
  }
}
@keyframes typing-caret-only {
  0%,.35%,100% {
    visibility: hidden;
  }
  .36%,8.5% {
    visibility: visible;
  }
  8.51% {
    visibility: hidden;
  }
}
@keyframes typing-caret-blink {
  0%,49.9% {
    opacity: 1;
  }
  50%,100% {
    opacity: 0;
  }
}
html:has(#docs-pause-motion:checked) .typing-copy .typing-text,
html:has(#docs-pause-motion:checked) .typing-copy .typing-character {
  animation: none!important;
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .typing-copy .typing-character::after {
  animation: none!important;
  opacity: 0;
  visibility: hidden;
}
@media(prefers-reduced-motion:reduce) {
  .typing-text,.typing-character {
    animation: none!important;
    opacity: 1;
  }
}
@media(prefers-reduced-motion:reduce) {
  .typing-character::after {
    animation: none!important;
    opacity: 0;
    visibility: hidden;
  }
}
</style>
