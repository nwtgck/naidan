<script setup lang="ts">
import { generateId } from '@/01-models/id';
import { idToRaw } from '@/01-models/ids';
import type { RecipeImportCandidateId } from '@/01-models/ids';
import { ref, watch } from 'vue';
import {
  ChefHatIcon, SaveIcon, AlertTriangleIcon,
} from 'lucide-vue-next';
import { parseConcatenatedJson } from '@/utils/json-stream-parser';
import { matchRecipeModels } from '@/features/recipes/logic/recipe-matcher';
import { ChatGroupRecipeSchema } from '@/features/recipes/logic/recipe';
import type { ChatGroupRecipe } from '@/features/recipes/logic/recipe';
import ModelSelector from '@/components/ModelSelector.vue';
import { naturalSort } from '@/utils/string';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  availableModels: readonly string[],
}>();

const emit = defineEmits<{
  (e: 'import', recipes: { newName: string, matchedModelId?: string, recipe: ChatGroupRecipe }[]): void,
}>();

interface AnalyzedRecipe {
  id: RecipeImportCandidateId,
  recipe: ChatGroupRecipe,
  selected: boolean,
  matchedModelId?: string,
  matchError?: string,
  newName: string,
}

const recipeJsonInput = ref('');
const analyzedRecipes = ref<AnalyzedRecipe[]>([]);
const recipeAnalysisError = ref<string | null>(null);

function getSortedModels({ matchedModelId }: { matchedModelId?: string }) {
  const models = naturalSort({ values: props.availableModels || [] });
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
  const parseResults = parseConcatenatedJson({ input: trimmed });
  const newAnalyzed: AnalyzedRecipe[] = [];

  for (const result of parseResults) {
    if (!result.success) {
      // TODO(strings-localize): Localize analysis errors without making synchronous parsing state asynchronous.
      recipeAnalysisError.value = `Parse error: ${result.error}`;
      continue;
    }

    const validation = ChatGroupRecipeSchema.safeParse(result.data);
    if (!validation.success) {
      // TODO(strings-localize): Localize analysis errors without making synchronous parsing state asynchronous.
      recipeAnalysisError.value = `Validation error: ${validation.error.message}`;
      continue;
    }

    const recipe = validation.data;
    const match = matchRecipeModels({ recipeModels: recipe.models, availableModelIds: props.availableModels });

    newAnalyzed.push({
      id: generateId<RecipeImportCandidateId>(),
      recipe,
      selected: true,
      matchedModelId: match.modelId,
      matchError: match.error,
      newName: recipe.name,
    });
  }

  if (newAnalyzed.length === 0 && !recipeAnalysisError.value) {
    // TODO(strings-localize): Localize this validation result without changing the synchronous analysis contract.
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
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="recipes-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-8 duration-400">
    <section tw-class="space-y-6">
      <div tw-class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <ChefHatIcon tw-class="w-5 h-5 text-blue-500" />
        <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.RecipeImportTab__recipes() }}</h2>
      </div>

      <p tw-class="text-sm font-medium text-gray-500">
        {{ lazyStrings.RecipeImportTab__import_chat_group_recipes() }}
      </p>

      <div tw-class="space-y-4">
        <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported() }}</label>
        <textarea
          v-model="recipeJsonInput"
          rows="8"
          tw-class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-xs font-mono text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
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

        <div v-if="recipeAnalysisError" class="animate-in fade-in slide-in-from-top-1" tw-class="p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-xl duration-200">
          <p tw-class="text-xs text-red-600 dark:text-red-400 font-bold flex items-center gap-2">
            <AlertTriangleIcon tw-class="w-4 h-4" />
            {{ recipeAnalysisError }}
          </p>
        </div>
      </div>

      <!-- Analyzed Recipes List -->
      <div v-if="analyzedRecipes.length > 0" class="animate-in fade-in slide-in-from-top-2" tw-class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800 duration-300">
        <div tw-class="flex items-center justify-between">
          <h3 tw-class="text-sm font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.RecipeImportTab__detected_recipes({ recipeCount: analyzedRecipes.length }) }}</h3>
          <button
            @click="handleImportRecipes"
            tw-class="px-8 py-3 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-2xl shadow-lg shadow-green-500/30 transition-all active:scale-95 flex items-center gap-2"
            data-testid="recipe-import-button"
          >
            <SaveIcon tw-class="w-4 h-4" />
            {{ lazyStrings.RecipeImportTab__import_selected() }}
          </button>
        </div>

        <div tw-class="grid grid-cols-1 gap-4">
          <div
            v-for="item in analyzedRecipes"
            :key="idToRaw({ id: item.id })"
            tw-class="p-5 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-3xl flex items-start gap-4 transition-all hover:border-blue-500/30"
          >
            <input
              type="checkbox"
              v-model="item.selected"
              tw-class="mt-1 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            >
            <div tw-class="flex-1 min-w-0 space-y-3">
              <div tw-class="flex flex-col gap-1.5">
                <label tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-widest ml-0.5">{{ lazyStrings.RecipeImportTab__chat_group_name() }}</label>
                <input
                  v-model="item.newName"
                  tw-class="bg-transparent border-b border-gray-100 dark:border-gray-700 hover:border-blue-500 focus:border-blue-500 focus:outline-none text-base font-bold text-gray-800 dark:text-white transition-all w-full pb-1"
                  :placeholder="lazyStrings.RecipeImportTab__chat_group_name()"
                />
                <p v-if="item.recipe.description" tw-class="text-xs text-gray-500 dark:text-gray-400 font-medium ml-0.5 mt-1">{{ item.recipe.description }}</p>
              </div>

              <div tw-class="space-y-2">
                <label tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-widest ml-0.5">{{ lazyStrings.RecipeImportTab__model_selection() }}</label>
                <div tw-class="flex flex-col gap-2">
                  <ModelSelector
                    v-model="item.matchedModelId"
                    :models="getSortedModels({ matchedModelId: item.matchedModelId })"
                    :placeholder="lazyStrings.RecipeImportTab__use_default_model()"
                    allow-clear
                    :clear-label="lazyStrings.RecipeImportTab__use_default_model()"
                  />
                  <div v-if="item.matchError" tw-class="text-[10px] px-2 py-1 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800 rounded-lg font-bold flex items-center gap-1.5 w-fit">
                    <AlertTriangleIcon tw-class="w-3 h-3" />
                    {{ item.matchError }}
                  </div>
                </div>
              </div>

              <div v-if="item.recipe.systemPrompt" tw-class="p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-100/50 dark:border-gray-800/50">
                <div tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">{{ lazyStrings.RecipeImportTab__system_prompt({ behavior: item.recipe.systemPrompt.behavior }) }}</div>
                <p tw-class="text-[11px] text-gray-600 dark:text-gray-400 line-clamp-2 italic font-medium">"{{ item.recipe.systemPrompt.content }}"</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
