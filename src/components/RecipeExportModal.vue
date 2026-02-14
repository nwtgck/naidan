<script setup lang="ts">
import { generateId } from '../utils/id';
import { ref, computed, watch } from 'vue';
import {
  X, ChefHat, Copy, Check, Plus, Trash2, Info, Globe, AlertCircle, MessageSquareQuote
} from 'lucide-vue-next';
import type { ChatGroupRecipe, RecipeSystemPrompt } from '../models/recipe';
import type { LmParameters, SystemPrompt } from '../models/types';
import { generateDefaultModelPatterns } from '../utils/recipe-matcher';

const props = defineProps<{
  isOpen: boolean;
  groupName: string;
  systemPrompt?: SystemPrompt;
  lmParameters?: LmParameters;
  initialModelId?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const recipeForm = ref({
  name: props.groupName,
  description: '',
  systemPrompt: props.systemPrompt ? { ...props.systemPrompt } : { content: '' as string | null, behavior: 'override' as const },
  models: [] as { id: string; pattern: string; caseSensitive: boolean }[],
});

function initForm() {
  const modelPatterns = props.initialModelId
    ? generateDefaultModelPatterns(props.initialModelId).map(p => ({ id: generateId(), pattern: p, caseSensitive: false }))
    : [];

  recipeForm.value = {
    name: props.groupName,
    description: '',
    systemPrompt: props.systemPrompt ? { ...props.systemPrompt } : { content: '' as string | null, behavior: 'override' as const },
    models: modelPatterns,
  };
}

// Reset form when modal opens
watch(() => props.isOpen, (open) => {
  if (open) {
    initForm();
  }
});

const copySuccess = ref(false);

const exportedRecipeJson = computed(() => {
  // Use behavior 'override' with content null for "Clear"
  const hasSystemPrompt = recipeForm.value.systemPrompt.content !== null || recipeForm.value.systemPrompt.behavior === 'append';
  const isExplicitClear = recipeForm.value.systemPrompt.behavior === 'override' && recipeForm.value.systemPrompt.content === null;

  const recipe: ChatGroupRecipe = {
    type: 'chat_group_recipe',
    name: recipeForm.value.name,
    description: recipeForm.value.description || undefined,
    systemPrompt: (hasSystemPrompt || isExplicitClear) ? (recipeForm.value.systemPrompt as RecipeSystemPrompt) : undefined,
    lmParameters: props.lmParameters,
    models: recipeForm.value.models.map(m => ({
      type: 'regex',
      pattern: m.pattern,
      flags: m.caseSensitive ? [] : ['i'],
    })),
  };

  return JSON.stringify(recipe, null, 2);
});

function addModelPattern() {
  recipeForm.value.models.push({ id: generateId(), pattern: '', caseSensitive: false });
}

function removeModelPattern(id: string) {
  const index = recipeForm.value.models.findIndex(m => m.id === id);
  if (index !== -1) {
    recipeForm.value.models.splice(index, 1);
  }
}

function isRegexValid(pattern: string): boolean {
  if (!pattern) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch (e) {
    return false;
  }
}

async function copyToClipboard() {
  if (exportedRecipeJson.value) {
    await navigator.clipboard.writeText(exportedRecipeJson.value);
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 2000);
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px]">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-5xl h-[85vh] overflow-hidden flex flex-col md:flex-row border border-gray-100 dark:border-gray-800 modal-content-zoom relative">

        <!-- Top Right Close Button -->
        <button
          @click="emit('close')"
          class="absolute top-4 right-4 z-[70] p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors"
        >
          <X class="w-5 h-5" />
        </button>

        <!-- Editor Section -->
        <div class="flex-1 flex flex-col min-h-0 bg-white dark:bg-gray-900 border-r border-gray-100 dark:border-gray-800">
          <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
            <div class="flex items-center gap-2">
              <ChefHat class="w-5 h-5 text-blue-500" />
              <h3 class="text-base font-bold text-gray-800 dark:text-white">Recipe Editor</h3>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-6 space-y-8 overscroll-contain">
            <!-- Basic Info -->
            <div class="grid grid-cols-1 gap-6">
              <div class="space-y-2">
                <label class="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Recipe Name</label>
                <input
                  v-model="recipeForm.name"
                  type="text"
                  class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-bold text-gray-800 dark:text-white outline-none focus:ring-4 focus:ring-blue-500/10 transition-all shadow-sm"
                />
              </div>

              <div class="space-y-2">
                <label class="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Description</label>
                <textarea
                  v-model="recipeForm.description"
                  rows="2"
                  class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 dark:text-white outline-none focus:ring-4 focus:ring-blue-500/10 transition-all resize-none shadow-sm"
                  placeholder="What makes this recipe special?"
                ></textarea>
              </div>
            </div>

            <!-- System Prompt Editor -->
            <div class="space-y-4 pt-4 border-t border-gray-100 dark:border-gray-800">
              <div class="flex items-center justify-between ml-1">
                <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest flex items-center gap-2">
                  <MessageSquareQuote class="w-3 h-3" />
                  Recipe System Prompt
                </label>

                <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                  <button
                    @click="recipeForm.systemPrompt = { behavior: 'override', content: null }"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="recipeForm.systemPrompt.behavior === 'override' && recipeForm.systemPrompt.content === null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Clear
                  </button>
                  <button
                    @click="recipeForm.systemPrompt = { behavior: 'override', content: recipeForm.systemPrompt.content ?? '' }"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="recipeForm.systemPrompt.behavior === 'override' && recipeForm.systemPrompt.content !== null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Override
                  </button>
                  <button
                    @click="recipeForm.systemPrompt = { behavior: 'append', content: recipeForm.systemPrompt.content ?? '' }"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="recipeForm.systemPrompt.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Append
                  </button>
                </div>
              </div>
              <textarea
                v-if="!(recipeForm.systemPrompt.behavior === 'override' && recipeForm.systemPrompt.content === null)"
                v-model="recipeForm.systemPrompt.content"
                rows="5"
                class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 dark:text-white outline-none focus:ring-4 focus:ring-blue-500/10 transition-all resize-none shadow-sm"
                placeholder="Include custom instructions in the recipe..."
              ></textarea>
              <div
                v-else
                class="w-full bg-gray-50/50 dark:bg-gray-800/30 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center"
              >
                <p class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Parent Prompt Cleared</p>
                <p class="text-[9px] text-gray-400 dark:text-gray-500 mt-1">This recipe will explicitly clear any inherited system instructions.</p>
              </div>
            </div>

            <!-- Model Rules -->
            <div class="space-y-4 pt-4 border-t border-gray-100 dark:border-gray-800">
              <div class="flex items-center justify-between ml-1">
                <label class="block text-[10px] font-bold text-gray-400 uppercase tracking-widest">Model Matching Rules (Regex)</label>
                <button
                  @click="addModelPattern"
                  class="text-[10px] font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1"
                >
                  <Plus class="w-3 h-3" />
                  Add Rule
                </button>
              </div>

              <div v-if="recipeForm.models.length === 0" class="text-[11px] text-gray-400 italic ml-1 p-4 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl">
                No matching rules. Recipe will use the default model.
              </div>

              <TransitionGroup name="list" tag="div" class="space-y-4">
                <div v-for="m in recipeForm.models" :key="m.id" class="space-y-2">
                  <div class="flex gap-2 items-center">
                    <div
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border rounded-xl flex overflow-hidden transition-colors"
                      :class="isRegexValid(m.pattern) ? 'border-gray-100 dark:border-gray-700' : 'border-red-300 dark:border-red-900/50'"
                    >
                      <div class="bg-gray-100 dark:bg-gray-700 px-3 py-3 text-[10px] font-bold text-gray-400 flex items-center border-r border-gray-200 dark:border-gray-600 uppercase tracking-tighter">Regex</div>
                      <input
                        v-model="m.pattern"
                        type="text"
                        class="flex-1 bg-transparent px-4 py-3 text-sm font-mono text-gray-800 dark:text-white outline-none"
                        placeholder="^llama3.*$"
                      />
                      <button
                        @click="m.caseSensitive = !m.caseSensitive"
                        class="px-3 py-3 text-[9px] font-bold transition-colors border-l border-gray-200 dark:border-gray-600 tracking-tight"
                        :class="m.caseSensitive ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-400 hover:text-gray-600'"
                        title="Toggle Case Sensitivity"
                      >
                        Aa
                      </button>
                    </div>
                    <button @click="removeModelPattern(m.id)" class="p-2 text-gray-400 hover:text-red-500 transition-colors">
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                  <div v-if="!isRegexValid(m.pattern)" class="flex items-center gap-1.5 ml-1 text-red-500">
                    <AlertCircle class="w-3 h-3" />
                    <span class="text-[9px] font-bold uppercase tracking-wide">Invalid Regular Expression</span>
                  </div>
                </div>
              </TransitionGroup>
            </div>

            <!-- Footer Info -->
            <div class="p-4 bg-blue-50/50 dark:bg-blue-900/10 rounded-2xl border border-blue-100/50 dark:border-blue-900/20">
              <div class="flex items-start gap-3">
                <Info class="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                <p class="text-[10px] text-blue-700 dark:text-blue-300 font-medium leading-relaxed">
                  Temperature, Top-P, and other LM parameters are automatically included from your current group overrides.
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Preview Section -->
        <div class="w-full md:w-[400px] bg-gray-50/50 dark:bg-black/20 flex flex-col min-h-0">
          <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-800 bg-white/50 dark:bg-gray-900/50 space-y-4">
            <div class="flex items-center gap-2">
              <Globe class="w-4 h-4 text-gray-400" />
              <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Live Recipe Preview</h3>
            </div>

            <button
              @click="copyToClipboard"
              class="w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-2xl font-bold text-sm transition-all shadow-lg active:scale-95 border"
              :class="copySuccess
                ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 border-green-100 dark:border-green-800 shadow-green-500/10'
                : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-500 shadow-blue-500/20'"
              data-testid="recipe-export-copy-button"
            >
              <Check v-if="copySuccess" class="w-4 h-4 animate-in zoom-in duration-300" />
              <Copy v-else class="w-4 h-4" />
              <span>{{ copySuccess ? 'Copied to Clipboard!' : 'Copy Recipe JSON' }}</span>
            </button>
          </div>

          <div class="flex-1 overflow-hidden relative">
            <pre class="h-full w-full p-6 overflow-auto font-mono text-[10px] text-gray-500 dark:text-gray-400 leading-relaxed scrollbar-thin whitespace-pre-wrap break-words overscroll-contain">{{ exportedRecipeJson }}</pre>
            <div class="absolute bottom-0 inset-x-0 h-12 bg-gradient-to-t from-gray-50/80 dark:from-black/40 to-transparent pointer-events-none"></div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.9);
  opacity: 0;
}

/* List Transition */
.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}
.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(-15px);
}

/* Thin Scrollbar */
.scrollbar-thin::-webkit-scrollbar {
  width: 4px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.4);
}
</style>