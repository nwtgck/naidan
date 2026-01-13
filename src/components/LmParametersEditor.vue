<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { LmParameters } from '../models/types';
import { RotateCcw, X } from 'lucide-vue-next';

const props = defineProps<{ 
  modelValue?: LmParameters;
}>();

const emit = defineEmits<{ 
  (e: 'update:modelValue', value: LmParameters): void;
}>();

const params = computed({
  get: () => props.modelValue || {},
  set: (val) => emit('update:modelValue', val)
});

const stopSequencesRaw = ref('');
const stopJsonError = ref<string | null>(null);

watch(() => params.value.stop, (newVal) => {
  const str = newVal ? JSON.stringify(newVal) : '';
  if (str !== stopSequencesRaw.value && !stopJsonError.value) {
    stopSequencesRaw.value = str;
  }
}, { immediate: true });

function updateParam<K extends keyof LmParameters>(key: K, value: LmParameters[K]) {
  const newParams = { ...params.value };
  if (value === undefined || value === null || (value as unknown) === '' || (typeof value === 'number' && isNaN(value))) {
    delete newParams[key];
  } else {
    newParams[key] = value;
  }
  params.value = newParams;
}

function handleStopInput(value: string) {
  stopSequencesRaw.value = value;
  if (!value.trim()) {
    updateParam('stop', undefined);
    stopJsonError.value = null;
    return;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      updateParam('stop', parsed.length > 0 ? parsed : undefined);
      stopJsonError.value = null;
    } else {
      stopJsonError.value = 'Must be an array of strings';
    }
  } catch (e) {
    stopJsonError.value = 'Invalid JSON';
  }
}

function reset() {
  params.value = {};
  stopSequencesRaw.value = '';
  stopJsonError.value = null;
}

const isOverridden = (key: keyof LmParameters) => params.value[key] !== undefined;

</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest">LM Parameters</h3>
        <span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800">
          Empty fields use provider defaults
        </span>
      </div>
      <button 
        v-if="Object.keys(params).length > 0"
        @click="reset"
        class="text-[10px] font-bold text-gray-400 hover:text-blue-500 flex items-center gap-1 transition-colors"
      >
        <RotateCcw class="w-3 h-3" />
        Reset All
      </button>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8">
      <!-- Temperature -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden('temperature') }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden('temperature') ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            Temperature
            <span v-if="isOverridden('temperature')" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input 
              type="number" step="0.1" min="0" max="2"
              :value="params.temperature"
              @input="e => updateParam('temperature', (e.target as HTMLInputElement).valueAsNumber)"
              placeholder="Default"
              class="w-16 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden('temperature')" @click="updateParam('temperature', undefined)" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><X class="w-3 h-3"/></button>
          </div>
        </div>
        <input 
          type="range" min="0" max="2" step="0.01"
          :value="params.temperature ?? 1"
          @input="e => updateParam('temperature', parseFloat((e.target as HTMLInputElement).value))"
          class="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
      </div>

      <!-- Top P -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden('topP') }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden('topP') ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            Top P
            <span v-if="isOverridden('topP')" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input 
              type="number" step="0.01" min="0" max="1"
              :value="params.topP"
              @input="e => updateParam('topP', (e.target as HTMLInputElement).valueAsNumber)"
              placeholder="Default"
              class="w-16 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden('topP')" @click="updateParam('topP', undefined)" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><X class="w-3 h-3"/></button>
          </div>
        </div>
        <input 
          type="range" min="0" max="1" step="0.01"
          :value="params.topP ?? 1"
          @input="e => updateParam('topP', parseFloat((e.target as HTMLInputElement).value))"
          class="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
      </div>

      <!-- Max Tokens -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden('maxCompletionTokens') }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden('maxCompletionTokens') ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            Max Tokens
            <span v-if="isOverridden('maxCompletionTokens')" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input 
              type="number" min="1"
              :value="params.maxCompletionTokens"
              @input="e => updateParam('maxCompletionTokens', (e.target as HTMLInputElement).valueAsNumber)"
              placeholder="Default"
              class="w-24 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden('maxCompletionTokens')" @click="updateParam('maxCompletionTokens', undefined)" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><X class="w-3 h-3"/></button>
          </div>
        </div>
      </div>

      <!-- Presence Penalty -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden('presencePenalty') }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden('presencePenalty') ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            Presence Penalty
            <span v-if="isOverridden('presencePenalty')" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input 
              type="number" step="0.1" min="-2" max="2"
              :value="params.presencePenalty"
              @input="e => updateParam('presencePenalty', (e.target as HTMLInputElement).valueAsNumber)"
              placeholder="Default"
              class="w-16 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden('presencePenalty')" @click="updateParam('presencePenalty', undefined)" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><X class="w-3 h-3"/></button>
          </div>
        </div>
        <input 
          type="range" min="-2" max="2" step="0.01"
          :value="params.presencePenalty ?? 0"
          @input="e => updateParam('presencePenalty', parseFloat((e.target as HTMLInputElement).value))"
          class="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
      </div>

      <!-- Stop Sequences -->
      <div class="space-y-3 col-span-1 md:col-span-2" :class="{ 'opacity-60': !isOverridden('stop') }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden('stop') ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            Stop Sequences (JSON Array)
            <span v-if="isOverridden('stop')" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <button v-if="isOverridden('stop')" @click="updateParam('stop', undefined)" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400 flex items-center gap-1 text-[10px] font-bold">
            <X class="w-3 h-3"/> Reset to Default
          </button>
        </div>
        <textarea 
          :value="stopSequencesRaw"
          @input="e => handleStopInput((e.target as HTMLTextAreaElement).value)"
          rows="2"
          class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-mono font-bold outline-none focus:border-blue-500 transition-all shadow-sm resize-none"
          :class="{ 'border-red-500 focus:border-red-500': stopJsonError }"
          placeholder='["\n", "User:"]'
        ></textarea>
        <p v-if="stopJsonError" class="text-[9px] text-red-500 font-bold ml-1">{{ stopJsonError }}</p>
      </div>
    </div>
  </div>
</template>
