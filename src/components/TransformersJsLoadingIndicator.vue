<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { transformersJsService } from '../services/transformers-js';
import { BrainCircuit, AlertTriangle, ShieldCheck } from 'lucide-vue-next';

const props = defineProps<{
  mode?: 'full' | 'compact';
}>();

const status = ref(transformersJsService.getState().status);
const progress = ref(transformersJsService.getState().progress);
const error = ref(transformersJsService.getState().error);
const isLoadingFromCache = ref(transformersJsService.getState().isLoadingFromCache);
const loadingModelId = ref(transformersJsService.getState().loadingModelId);

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = transformersJsService.subscribe((s, p, e, _c, l, _items, lm) => {
    status.value = s;
    progress.value = p;
    error.value = e;
    isLoadingFromCache.value = l;
    loadingModelId.value = lm;
  });
});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
});

// Tab Title Progress
const originalTitle = ref(typeof document !== 'undefined' ? document.title : 'Naidan');
watch([status, progress], ([s, p]) => {
  if (typeof document === 'undefined') return;
  switch (s) {
  case 'loading':
    document.title = `(${p}%) Loading Model...`;
    break;
  case 'idle':
  case 'ready':
  case 'error':
    document.title = originalTitle.value;
    break;
  default: {
    const _ex: never = s;
    return _ex;
  }
  }
}, { immediate: true });

const statusText = computed(() => {
  const currentStatus = status.value;
  switch (currentStatus) {
  case 'error':
    return 'Transformers.js error';
  case 'loading': {
    const modelName = loadingModelId.value ? loadingModelId.value.split('/').pop() : 'model';
    if (isLoadingFromCache.value) {
      return `Initializing ${modelName}...`;
    }
    return `Downloading ${modelName}...`;
  }
  case 'idle':
  case 'ready':
    return '';
  default: {
    const _ex: never = currentStatus;
    throw new Error(`Unhandled status: ${_ex}`);
  }
  }
});
const explanationText = computed(() => {
  if (isLoadingFromCache.value) {
    return 'Loading model weights into browser memory for local inference.';
  }
  return 'Downloading model weights from Hugging Face. This only happens once per model.';
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div v-if="status === 'loading' || status === 'error'" class="animate-in fade-in duration-500">
    <!-- Full Mode (Integrated Chat Flow) -->
    <div v-if="mode === 'full'" class="flex flex-col gap-4 p-5">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl flex items-center justify-center border border-blue-100 dark:border-blue-900/30 bg-blue-50/50 dark:bg-blue-900/20 shadow-sm">
          <BrainCircuit class="w-4 h-4 text-blue-500" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-2">
            <div class="flex flex-col">
              <span class="text-[10px] font-bold text-blue-600 dark:text-blue-400 tracking-wider">
                {{ statusText }}
              </span>
              <span class="text-[9px] text-gray-400 font-medium">
                {{ explanationText }}
              </span>
            </div>
            <span class="text-[10px] font-bold text-blue-500/70 tabular-nums self-start mt-0.5">{{ progress }}%</span>
          </div>
          <div class="h-1 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
            <div
              class="h-full transition-all duration-500 ease-out"
              :class="status === 'error' ? 'bg-red-500' : 'bg-blue-500 dark:bg-blue-400'"
              :style="{ width: progress + '%' }"
            ></div>
          </div>
        </div>
      </div>

      <!-- Feature Badges (Why we wait) -->
      <div v-if="status !== 'error'" class="ml-11 flex flex-wrap gap-3">
        <div class="flex items-center gap-1.5 text-[9px] font-bold text-gray-400 tracking-tight">
          <ShieldCheck class="w-3 h-3 text-green-500/70" />
          On-device Execution
        </div>
      </div>

      <div v-if="status === 'error' && error" class="ml-11 p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl text-[10px] text-red-600 dark:text-red-400 font-medium leading-relaxed flex items-start gap-2">
        <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
        {{ error }}
      </div>
    </div>

    <!-- Compact Mode (Fallback) -->
    <div v-else class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
      <BrainCircuit class="w-3 h-3 animate-pulse" />
      <span class="text-[10px] font-bold">{{ progress }}%</span>
    </div>
  </div>
</template>
