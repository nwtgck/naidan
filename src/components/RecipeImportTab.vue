<script setup lang="ts">
import { generateId } from '../utils/id';
import { ref, watch } from 'vue';
import { 
  ChefHat, Save, AlertTriangle
} from 'lucide-vue-next';
import { parseConcatenatedJson } from '../utils/json-stream-parser';
import { matchRecipeModels } from '../utils/recipe-matcher';
import { ChatGroupRecipeSchema } from '../models/recipe';
import type { ChatGroupRecipe } from '../models/recipe';
import ModelSelector from './ModelSelector.vue';
import { naturalSort } from '../utils/string';

const props = defineProps<{
  availableModels: readonly string[];
}>();

const emit = defineEmits<{
  (e: 'import', recipes: { newName: string; matchedModelId?: string; recipe: ChatGroupRecipe }[]): void;
}>();

interface AnalyzedRecipe {
  id: string;
  recipe: ChatGroupRecipe;
  selected: boolean;
  matchedModelId?: string;
  matchError?: string;
  newName: string;
}

const recipeJsonInput = ref('');
const analyzedRecipes = ref<AnalyzedRecipe[]>([]);
const recipeAnalysisError = ref<string | null>(null);

function getSortedModels(matchedModelId?: string) {
  const models = naturalSort(props.availableModels || []);
  if (!matchedModelId) return models;
  
  const index = models.indexOf(matchedModelId);
  if (index > -1) {
    models.splice(index, 1);
    models.unshift(matchedModelId);
  }
  return models;
}

function handleAnalyzeRecipes() {
  const trimmed = recipeJsonInput.value.trim();
  if (!trimmed) {
    analyzedRecipes.value = [];
    recipeAnalysisError.value = null;
    return;
  }

  recipeAnalysisError.value = null;
  const parseResults = parseConcatenatedJson(trimmed);
  const newAnalyzed: AnalyzedRecipe[] = [];

  for (const result of parseResults) {
    if (!result.success) {
      recipeAnalysisError.value = `Parse error: ${result.error}`;
      continue;
    }

    const validation = ChatGroupRecipeSchema.safeParse(result.data);
    if (!validation.success) {
      recipeAnalysisError.value = `Validation error: ${validation.error.message}`;
      continue;
    }

    const recipe = validation.data;
    const match = matchRecipeModels(recipe.models, props.availableModels);

    newAnalyzed.push({
      id: generateId(),
      recipe,
      selected: true,
      matchedModelId: match.modelId,
      matchError: match.error,
      newName: recipe.name,
    });
  }

  if (newAnalyzed.length === 0 && !recipeAnalysisError.value) {
    recipeAnalysisError.value = 'No valid recipes found in input.';
  }

  analyzedRecipes.value = newAnalyzed;
}

// Automatically analyze on input change
watch(recipeJsonInput, () => {
  handleAnalyzeRecipes();
});

function handleImportRecipes() {
  const toImport = analyzedRecipes.value.filter(r => r.selected);
  if (toImport.length === 0) return;

  emit('import', toImport.map(item => ({
    newName: item.newName,
    matchedModelId: item.matchedModelId,
    recipe: item.recipe,
  })));

  // Reset state
  analyzedRecipes.value = [];
  recipeJsonInput.value = '';
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div data-testid="recipes-section" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <ChefHat class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Recipes</h2>
      </div>
    
      <p class="text-sm font-medium text-gray-500">
        Import predefined chat group settings (prompts, parameters, and model rules) from JSON.
      </p>

      <div class="space-y-4">
        <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Paste Recipe JSON (Concatenated JSON objects supported)</label>
        <textarea 
          v-model="recipeJsonInput"
          rows="8"
          class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-xs font-mono text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
          placeholder='{
  "type": "chat_group_recipe",
  "name": "Creative Writing",
  "models": [{"type": "regex", "pattern": "gpt-4", "flags": ["i"]}]
}
{
  "type": "chat_group_recipe",
  "name": "Code Assistant",
  "models": [{"type": "regex", "pattern": "claude-3", "flags": ["i"]}]
}'
          data-testid="recipe-json-input"
        ></textarea>
        
        <div v-if="recipeAnalysisError" class="p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-xl animate-in fade-in slide-in-from-top-1 duration-200">
          <p class="text-xs text-red-600 dark:text-red-400 font-bold flex items-center gap-2">
            <AlertTriangle class="w-4 h-4" />
            {{ recipeAnalysisError }}
          </p>
        </div>
      </div>

      <!-- Analyzed Recipes List -->
      <div v-if="analyzedRecipes.length > 0" class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800 animate-in fade-in slide-in-from-top-2 duration-300">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-gray-400 uppercase tracking-widest ml-1">Detected Recipes ({{ analyzedRecipes.length }})</h3>
          <button 
            @click="handleImportRecipes"
            class="px-8 py-3 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-2xl shadow-lg shadow-green-500/30 transition-all active:scale-95 flex items-center gap-2"
            data-testid="recipe-import-button"
          >
            <Save class="w-4 h-4" />
            Import Selected
          </button>
        </div>

        <div class="grid grid-cols-1 gap-4">
          <div 
            v-for="item in analyzedRecipes" 
            :key="item.id"
            class="p-5 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-3xl flex items-start gap-4 transition-all hover:border-blue-500/30"
          >
            <input 
              type="checkbox" 
              v-model="item.selected"
              class="mt-1 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            >
            <div class="flex-1 min-w-0 space-y-3">
              <div class="flex flex-col gap-1.5">
                <label class="text-[9px] font-bold text-gray-400 uppercase tracking-widest ml-0.5">Chat Group Name</label>
                <input 
                  v-model="item.newName"
                  class="bg-transparent border-b border-gray-100 dark:border-gray-700 hover:border-blue-500 focus:border-blue-500 focus:outline-none text-base font-bold text-gray-800 dark:text-white transition-all w-full pb-1"
                  placeholder="Chat Group Name"
                />
                <p v-if="item.recipe.description" class="text-xs text-gray-500 dark:text-gray-400 font-medium ml-0.5 mt-1">{{ item.recipe.description }}</p>
              </div>

              <div class="space-y-2">
                <label class="text-[9px] font-bold text-gray-400 uppercase tracking-widest ml-0.5">Model Selection</label>
                <div class="flex flex-col gap-2">
                  <ModelSelector 
                    v-model="item.matchedModelId"
                    :models="getSortedModels(item.matchedModelId)"
                    placeholder="Use Default Model"
                    allow-clear
                    clear-label="Use Default Model"
                  />
                  <div v-if="item.matchError" class="text-[10px] px-2 py-1 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800 rounded-lg font-bold flex items-center gap-1.5 w-fit">
                    <AlertTriangle class="w-3 h-3" />
                    {{ item.matchError }}
                  </div>
                </div>
              </div>

              <div v-if="item.recipe.systemPrompt" class="p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-100/50 dark:border-gray-800/50">
                <div class="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">System Prompt ({{ item.recipe.systemPrompt.behavior }})</div>
                <p class="text-[11px] text-gray-600 dark:text-gray-400 line-clamp-2 italic font-medium">"{{ item.recipe.systemPrompt.content }}"</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>