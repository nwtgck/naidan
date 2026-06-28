<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import type { LmParameters } from '@/01-models/types';
import { RotateCcwIcon, XIcon } from 'lucide-vue-next';
import { hasLmParameterOverrides } from '@/utils/lm-parameters';

const props = defineProps<{
  modelValue?: LmParameters,
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: LmParameters): void,
}>();

const defaultParams: LmParameters = {
  temperature: undefined,
  topP: undefined,
  maxCompletionTokens: undefined,
  presencePenalty: undefined,
  frequencyPenalty: undefined,
  stop: undefined,
  reasoning: { effort: undefined },
};

const params = computed<LmParameters>({
  get: () => ({ ...defaultParams, ...props.modelValue }),
  set: (val) => emit('update:modelValue', val),
});

const stopSequencesRaw = ref('');
const stopJsonErrorType = ref<'array_of_strings' | 'invalid_json' | null>(null);
const stopJsonError = computed(() => {
  switch (stopJsonErrorType.value) {
  case 'array_of_strings':
    return lazyStrings.LmParametersEditor__must_be_an_array_of_strings();
  case 'invalid_json':
    return lazyStrings.LmParametersEditor__invalid_json();
  case null:
    return null;
  default: {
    const _ex: never = stopJsonErrorType.value;
    return _ex;
  }
  }
});

watch(() => params.value.stop, (newVal) => {
  const str = newVal ? JSON.stringify(newVal) : '';
  if (str !== stopSequencesRaw.value && stopJsonErrorType.value === null) {
    stopSequencesRaw.value = str;
  }
}, { immediate: true });

// Keep the key switches below exhaustive. Adding an LM parameter must stop
// typechecking until its clear and assignment semantics are implemented; this
// deliberately prevents a future refactor from silently ignoring the field.
function updateParam<K extends keyof LmParameters>({ key, value }: { key: K, value: LmParameters[K] }) {
  const newParams: LmParameters = { ...params.value };
  if (value === undefined || value === null || (value as unknown) === '' || (typeof value === 'number' && isNaN(value))) {
    switch (key) {
    case 'reasoning':
      newParams.reasoning = { effort: undefined };
      break;
    case 'temperature':
    case 'topP':
    case 'maxCompletionTokens':
    case 'presencePenalty':
    case 'frequencyPenalty':
    case 'stop':
      delete newParams[key];
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled parameter key: ${_ex}`);
    }
    }
  } else {
    switch (key) {
    case 'reasoning':
      newParams.reasoning = value as LmParameters['reasoning'];
      break;
    case 'temperature':
      newParams.temperature = value as LmParameters['temperature'];
      break;
    case 'topP':
      newParams.topP = value as LmParameters['topP'];
      break;
    case 'maxCompletionTokens':
      newParams.maxCompletionTokens = value as LmParameters['maxCompletionTokens'];
      break;
    case 'presencePenalty':
      newParams.presencePenalty = value as LmParameters['presencePenalty'];
      break;
    case 'frequencyPenalty':
      newParams.frequencyPenalty = value as LmParameters['frequencyPenalty'];
      break;
    case 'stop':
      newParams.stop = value as LmParameters['stop'];
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled parameter key: ${_ex}`);
    }
    }
  }
  params.value = newParams;
}

function handleStopInput({ value }: { value: string }) {
  stopSequencesRaw.value = value;
  if (!value.trim()) {
    updateParam({ key: 'stop', value: undefined });
    stopJsonErrorType.value = null;
    return;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      updateParam({ key: 'stop', value: parsed.length > 0 ? parsed : undefined });
      stopJsonErrorType.value = null;
    } else {
      stopJsonErrorType.value = 'array_of_strings';
    }
  } catch (e) {
    stopJsonErrorType.value = 'invalid_json';
  }
}

function reset() {
  params.value = { ...defaultParams };
  stopSequencesRaw.value = '';
  stopJsonErrorType.value = null;
}

// This exhaustive switch is also a compile-time review gate for new parameters.
// Do not replace it with a partial list of property checks.
const isOverridden = ({ key }: { key: keyof LmParameters }) => {
  switch (key) {
  case 'reasoning':
    return params.value.reasoning.effort !== undefined;
  case 'temperature':
  case 'topP':
  case 'maxCompletionTokens':
  case 'presencePenalty':
  case 'frequencyPenalty':
  case 'stop':
    return params.value[key] !== undefined;
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled parameter key: ${_ex}`);
  }
  }
};



defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.LmParametersEditor__lm_parameters() }}</h3>
        <span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800">
          {{ lazyStrings.LmParametersEditor__empty_fields_use_provider_defaults() }}
        </span>
      </div>
      <button
        v-if="hasLmParameterOverrides({ lmParameters: params })"
        @click="reset"
        class="text-[10px] font-bold text-gray-400 hover:text-blue-500 flex items-center gap-1 transition-colors"
      >
        <RotateCcwIcon class="w-3 h-3" />
        {{ lazyStrings.LmParametersEditor__reset_all() }}
      </button>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8">
      <!-- Temperature -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden({ key: 'temperature' }) }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden({ key: 'temperature' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            {{ lazyStrings.LmParametersEditor__temperature() }}
            <span v-if="isOverridden({ key: 'temperature' })" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input
              type="number" step="0.1" min="0" max="2"
              :value="params.temperature"
              @input="e => updateParam({ key: 'temperature', value: (e.target as HTMLInputElement).valueAsNumber })"
              :placeholder="lazyStrings.LmParametersEditor__default()"
              class="w-16 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden({ key: 'temperature' })" @click="updateParam({ key: 'temperature', value: undefined })" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><XIcon class="w-3 h-3"/></button>
          </div>
        </div>
        <input
          type="range" min="0" max="2" step="0.01"
          :value="params.temperature ?? 1"
          @input="e => updateParam({ key: 'temperature', value: parseFloat((e.target as HTMLInputElement).value) })"
          class="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
      </div>

      <!-- Top P -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden({ key: 'topP' }) }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden({ key: 'topP' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            {{ lazyStrings.LmParametersEditor__top_p() }}
            <span v-if="isOverridden({ key: 'topP' })" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input
              type="number" step="0.01" min="0" max="1"
              :value="params.topP"
              @input="e => updateParam({ key: 'topP', value: (e.target as HTMLInputElement).valueAsNumber })"
              :placeholder="lazyStrings.LmParametersEditor__default()"
              class="w-16 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden({ key: 'topP' })" @click="updateParam({ key: 'topP', value: undefined })" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><XIcon class="w-3 h-3"/></button>
          </div>
        </div>
        <input
          type="range" min="0" max="1" step="0.01"
          :value="params.topP ?? 1"
          @input="e => updateParam({ key: 'topP', value: parseFloat((e.target as HTMLInputElement).value) })"
          class="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
      </div>

      <!-- Max Tokens -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden({ key: 'maxCompletionTokens' }) }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden({ key: 'maxCompletionTokens' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            {{ lazyStrings.LmParametersEditor__max_tokens() }}
            <span v-if="isOverridden({ key: 'maxCompletionTokens' })" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input
              type="number" min="1"
              :value="params.maxCompletionTokens"
              @input="e => updateParam({ key: 'maxCompletionTokens', value: (e.target as HTMLInputElement).valueAsNumber })"
              :placeholder="lazyStrings.LmParametersEditor__default()"
              class="w-24 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden({ key: 'maxCompletionTokens' })" @click="updateParam({ key: 'maxCompletionTokens', value: undefined })" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><XIcon class="w-3 h-3"/></button>
          </div>
        </div>
      </div>

      <!-- Presence Penalty -->
      <div class="space-y-3" :class="{ 'opacity-60': !isOverridden({ key: 'presencePenalty' }) }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden({ key: 'presencePenalty' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            {{ lazyStrings.LmParametersEditor__presence_penalty() }}
            <span v-if="isOverridden({ key: 'presencePenalty' })" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <div class="flex items-center gap-2">
            <input
              type="number" step="0.1" min="-2" max="2"
              :value="params.presencePenalty"
              @input="e => updateParam({ key: 'presencePenalty', value: (e.target as HTMLInputElement).valueAsNumber })"
              :placeholder="lazyStrings.LmParametersEditor__default()"
              class="w-16 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-[11px] font-bold text-right outline-none focus:border-blue-500 transition-all"
            />
            <button v-if="isOverridden({ key: 'presencePenalty' })" @click="updateParam({ key: 'presencePenalty', value: undefined })" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"><XIcon class="w-3 h-3"/></button>
          </div>
        </div>
        <input
          type="range" min="-2" max="2" step="0.01"
          :value="params.presencePenalty ?? 0"
          @input="e => updateParam({ key: 'presencePenalty', value: parseFloat((e.target as HTMLInputElement).value) })"
          class="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
      </div>

      <!-- Stop Sequences -->
      <div class="space-y-3 col-span-1 md:col-span-2" :class="{ 'opacity-60': !isOverridden({ key: 'stop' }) }">
        <div class="flex justify-between items-center">
          <label class="text-xs font-bold flex items-center gap-1.5" :class="isOverridden({ key: 'stop' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'">
            {{ lazyStrings.LmParametersEditor__stop_sequences_json_array() }}
            <span v-if="isOverridden({ key: 'stop' })" class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
          </label>
          <button v-if="isOverridden({ key: 'stop' })" @click="updateParam({ key: 'stop', value: undefined })" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400 flex items-center gap-1 text-[10px] font-bold">
            <XIcon class="w-3 h-3"/> {{ lazyStrings.LmParametersEditor__reset_to_default() }}
          </button>
        </div>
        <textarea
          :value="stopSequencesRaw"
          @input="e => handleStopInput({ value: (e.target as HTMLTextAreaElement).value })"
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
