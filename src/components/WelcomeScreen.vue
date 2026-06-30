<script setup lang="ts">
import { computed } from 'vue';
import { ShieldCheckIcon, DownloadIcon, GhostIcon } from 'lucide-vue-next';
import { useSettings } from '@/composables/useSettings';
import { lazyStrings } from '@/strings';

defineProps<{
  hasInput?: boolean,
}>();

defineEmits<{
  (e: 'select-suggestion', text: string): void,
}>();

const { settings } = useSettings();
const appVersion = __APP_VERSION__;

// Access the build mode global defined in vite.config.ts
const isHosted = (() => {
  const t = typeof __BUILD_MODE_IS_HOSTED__;
  switch (t) {
  case 'undefined':
    return true;
  case 'boolean':
  case 'string':
  case 'number':
  case 'object':
  case 'function':
  case 'symbol':
  case 'bigint':
    return __BUILD_MODE_IS_HOSTED__;
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();

type Suggestion = {
  label: string,
  text: string,
};

const suggestions = computed<Suggestion[]>(() => {
  const values = [
    { label: lazyStrings.WelcomeScreen__write_a_story(), text: lazyStrings.WelcomeScreen__write_a_time_travel_detective_story() },
    { label: lazyStrings.WelcomeScreen__code_help(), text: lazyStrings.WelcomeScreen__explain_vue_composition_api() },
    { label: lazyStrings.WelcomeScreen__brainstorm(), text: lazyStrings.WelcomeScreen__home_automation_project_ideas() },
    { label: lazyStrings.WelcomeScreen__summarize(), text: lazyStrings.WelcomeScreen__summarize_local_lm_architectures() },
  ];
  return values.filter((value): value is Suggestion => (
    value.label !== undefined && value.text !== undefined
  ));
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div class="absolute inset-0 flex flex-col items-center justify-center p-6 sm:p-12 text-center pointer-events-none">
    <div class="w-full max-w-4xl flex flex-col items-center space-y-8 sm:space-y-12 translate-y-[-25%] sm:translate-y-[-30%] animate-in fade-in zoom-in duration-1000">

      <!-- Security Status Section -->
      <div class="flex flex-col items-center space-y-4 sm:space-y-6 pointer-events-auto">
        <div class="relative group">
          <!-- Subtle Glow Effect -->
          <div
            class="absolute inset-0 blur-2xl rounded-full scale-150 group-hover:scale-110 transition-transform duration-1000"
            :class="settings.storageType === 'memory' ? 'bg-indigo-500/20 dark:bg-indigo-500/10' : 'bg-emerald-500/20 dark:bg-emerald-500/10'"
          ></div>

          <div
            class="relative p-4 sm:p-5 rounded-[2rem] border shadow-sm"
            :class="settings.storageType === 'memory' ? 'bg-indigo-50 dark:bg-indigo-900/10 border-indigo-100 dark:border-indigo-900/20' : 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900/20'"
          >
            <GhostIcon v-if="settings.storageType === 'memory'" class="w-8 h-8 sm:w-10 sm:h-10 text-indigo-600 dark:text-indigo-400" />
            <ShieldCheckIcon v-else class="w-8 h-8 sm:w-10 sm:h-10 text-emerald-600 dark:text-emerald-400" />
          </div>
        </div>

        <div class="space-y-3 sm:space-y-4">
          <div class="space-y-1 sm:space-y-2">
            <h2 class="text-xl sm:text-3xl font-bold text-gray-800 dark:text-gray-100 tracking-tight leading-tight">
              <template v-if="settings.storageType === 'memory'">
                {{ lazyStrings.WelcomeScreen__conversations_are_stored_in_memory() }}
              </template>
              <template v-else>
                {{ lazyStrings.WelcomeScreen__all_conversations_are_stored_locally() }}
              </template>
            </h2>
            <p class="text-gray-500 dark:text-gray-400 text-xs sm:text-base font-medium max-w-sm mx-auto leading-relaxed">
              <template v-if="settings.storageType === 'memory'">
                {{ lazyStrings.WelcomeScreen__data_is_cleared_on_reload() }}
              </template>
              <template v-else>
                {{ lazyStrings.WelcomeScreen__your_data_stays_on_your_device() }}
              </template>
            </p>
          </div>

          <!-- Standalone Build Link (Only in Hosted Mode) -->
          <div v-if="isHosted" class="flex justify-center pt-1">
            <a
              href="./naidan-standalone.zip"
              :download="'naidan-standalone-v' + appVersion + '.zip'"
              class="group/btn flex items-center gap-2 px-3 py-1 sm:px-4 sm:py-1.5 rounded-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 hover:border-emerald-200 dark:hover:border-emerald-500/30 hover:shadow-md transition-all duration-300"
              :title="lazyStrings.WelcomeScreen__download_standalone_portable_version()"
            >
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span class="text-[9px] sm:text-[10px] font-bold text-gray-400 dark:text-gray-500 group-hover/btn:text-emerald-600 dark:group-hover/btn:text-emerald-400 transition-colors">{{ lazyStrings.WelcomeScreen__download_portable_app() }}</span>
              <DownloadIcon class="w-2.5 h-2.5 sm:w-3 sm:h-3 text-gray-300 dark:text-gray-600 group-hover/btn:text-emerald-500 dark:group-hover/btn:text-emerald-400 group-hover/btn:translate-y-0.5 transition-all" />
            </a>
          </div>
        </div>
      </div>

      <!-- Minimal Discovery Links -->
      <div
        data-testid="suggestions-container"
        class="pt-4 sm:pt-8 flex flex-wrap justify-center gap-x-6 sm:gap-x-8 gap-y-2 sm:gap-y-3 transition-all duration-700 pointer-events-auto"
        :class="hasInput ? 'opacity-0 pointer-events-none translate-y-2' : 'opacity-40 hover:opacity-100 translate-y-0'"
      >
        <button
          v-for="s in suggestions"
          :key="s.label"
          @click="$emit('select-suggestion', s.text)"
          class="text-[10px] sm:text-xs font-semibold text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
        >
          {{ s.label }}
        </button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(1.5rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in {
  animation-name: zoom-in;
}
</style>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(1.5rem); }
  to { opacity: 0; transform: translateY(1.5rem); }
  50% { opacity: 0.5; }
  to { opacity: 1; transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-bottom-4 {
  animation-name: slide-in-from-bottom;
}
</style>
