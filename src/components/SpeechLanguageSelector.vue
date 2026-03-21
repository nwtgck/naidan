<script setup lang="ts">
import { computed, ref } from 'vue';
import { Languages, ChevronDown, Check, RefreshCw } from 'lucide-vue-next';
import { webSpeechService, type SpeechLanguage } from '@/services/web-speech';

const props = defineProps<{
  messageId: string;
  content: string;
  isMini?: boolean;
  align?: 'up' | 'down';
}>();

const showMenu = ref(false);
const isRedetecting = ref(false);
const selectedLang = computed(() => webSpeechService.state.preferredLang);
const detectedLang = computed(() => webSpeechService.state.detectedLang);

const languages: { label: string; value: SpeechLanguage }[] = [
  { label: 'Auto Detect', value: 'auto' },
  { label: 'English', value: 'en-US' },
  { label: '日本語', value: 'ja-JP' },
  { label: '한국어', value: 'ko-KR' },
  { label: '中文', value: 'zh-CN' },
  { label: 'Français', value: 'fr-FR' },
  { label: 'Deutsch', value: 'de-DE' },
  { label: 'Español', value: 'es-ES' },
  { label: 'Русский', value: 'ru-RU' },
];

function setLanguage(lang: SpeechLanguage) {
  webSpeechService.setPreferredLang({ lang });
  showMenu.value = false;
}

function handleRedetect() {
  isRedetecting.value = true;
  webSpeechService.redetectLanguage({
    text: props.content,
    messageId: props.messageId
  });
  // Small delay for visual feedback
  setTimeout(() => {
    isRedetecting.value = false;
  }, 500);
}

function getDisplayLabel() {
  const lang = selectedLang.value;
  switch (lang) {
  case 'auto':
    return detectedLang.value ? detectedLang.value.split('-')[0]?.toUpperCase() : 'Auto';
  case 'en-US':
  case 'ja-JP':
  case 'ko-KR':
  case 'zh-CN':
  case 'ru-RU':
  case 'es-ES':
  case 'fr-FR':
  case 'de-DE':
    return lang.split('-')[0]?.toUpperCase();
  default: {
    const _ex: never = lang;
    return _ex;
  }
  }
}

function getFullLabel(langObj: { label: string; value: SpeechLanguage }) {
  const val = langObj.value;
  switch (val) {
  case 'auto':
    if (detectedLang.value) {
      const detected = languages.find(l => l.value === detectedLang.value);
      return `Auto Detect (${detected?.label || detectedLang.value})`;
    }
    return langObj.label;
  case 'en-US':
  case 'ja-JP':
  case 'ko-KR':
  case 'zh-CN':
  case 'ru-RU':
  case 'es-ES':
  case 'fr-FR':
  case 'de-DE':
    return langObj.label;
  default: {
    const _ex: never = val;
    return _ex;
  }
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="relative inline-flex items-center">
    <button
      @click.stop="showMenu = !showMenu"
      class="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 text-[9px] font-bold transition-colors"
      :class="[
        isMini
          ? 'text-gray-500 hover:text-blue-600'
          : 'bg-white/50 dark:bg-gray-800/50 text-blue-600/70 hover:text-blue-600'
      ]"
    >
      <Languages class="w-3 h-3" />
      <span>{{ getDisplayLabel() }}</span>
      <ChevronDown class="w-2.5 h-2.5 opacity-50" />
    </button>

    <div v-if="showMenu" class="fixed inset-0 z-40" @click.stop="showMenu = false"></div>

    <Transition name="zoom">
      <div
        v-if="showMenu"
        class="absolute w-40 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden animate-in zoom-in-95 duration-200"
        :class="[
          align === 'down' ? 'top-full left-0 mt-1 origin-top-left' : 'bottom-full left-0 mb-1 origin-bottom-left'
        ]"
      >
        <div class="px-3 py-1 text-[8px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">Language</div>
        <div class="max-h-48 overflow-y-auto custom-scrollbar">
          <div
            v-for="l in languages"
            :key="l.value"
            class="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
            :class="selectedLang === l.value ? 'text-blue-600 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
          >
            <button @click.stop="setLanguage(l.value)" class="flex-1 text-left">
              {{ getFullLabel(l) }}
            </button>

            <div class="flex items-center gap-2">
              <button
                v-if="l.value === 'auto'"
                @click.stop="handleRedetect"
                class="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 text-gray-400 hover:text-blue-600 transition-all"
                :class="{ 'animate-spin text-blue-600': isRedetecting }"
                title="Redetect language"
              >
                <RefreshCw class="w-2.5 h-2.5" />
              </button>
              <Check v-if="selectedLang === l.value" class="w-3 h-3" />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
