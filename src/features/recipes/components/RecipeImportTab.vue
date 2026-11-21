<script setup lang="ts">
import ActionButton from '@/components/ActionButton.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { generateId } from '@/01-models/id';
import { idToRaw } from '@/01-models/ids';
import type { RecipeImportCandidateId } from '@/01-models/ids';
import { computed, ref, useId, watch } from 'vue';
import {
  ChefHatIcon, FolderInputIcon, AlertTriangleIcon,
} from 'lucide-vue-next';
import { parseConcatenatedJson } from '@/utils/json-stream-parser';
import { matchRecipeModels } from '@/features/recipes/logic/recipe-matcher';
import { ChatGroupRecipeSchema } from '@/features/recipes/logic/recipe';
import type { ChatGroupRecipe } from '@/features/recipes/logic/recipe';
import ModelSelector from '@/components/ModelSelector.vue';
import type { ModelSelectorItem } from '@/components/model-selector-item';
import { naturalSort } from '@/utils/string';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  availableModels: readonly string[],
  modelAvailability: 'local' | 'remote',
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
const recipeJsonInputId = useId();
const analyzedRecipes = ref<AnalyzedRecipe[]>([]);
const selectedRecipes = computed(() => analyzedRecipes.value.filter(recipe => recipe.selected));
const recipeAnalysisError = ref<string | null>(null);

const sortedModels = computed<ModelSelectorItem[]>(() => naturalSort({ values: props.availableModels }).map(id => ({
  id,
  label: id,
  description: undefined,
  availability: props.modelAvailability,
})));

function getSortedModels({ matchedModelId }: { matchedModelId: string | undefined }): readonly ModelSelectorItem[] {
  const models = sortedModels.value;
  const matchedModel = models.find(model => model.id === matchedModelId);
  return matchedModel === undefined ? models : [matchedModel, ...models.filter(model => model !== matchedModel)];
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
  const toImport = selectedRecipes.value;
  if (toImport.length === 0) {
    return;
  }

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
  <div data-testid="recipes-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="duration-300 motion-reduce:animate-none">
    <section tw-class="space-y-6">
      <header tw-class="space-y-2">
        <div tw-class="flex items-center gap-2.5">
          <ChefHatIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />
          <h2 tw-class="text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.RecipeImportTab__recipes() }}</h2>
        </div>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.RecipeImportTab__import_chat_group_recipes() }}
        </p>
      </header>

      <div tw-class="space-y-2">
        <label :for="recipeJsonInputId" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.RecipeImportTab__paste_recipe_json_concatenated_json_objects_supported() }}</label>
        <textarea
          :id="recipeJsonInputId"
          v-model="recipeJsonInput"
          rows="8"
          tw-class="block w-full resize-none rounded-xl border border-gray-200 bg-gray-50/60 px-3.5 py-3 font-mono text-xs leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700/70 dark:bg-gray-800/45 dark:text-gray-100 dark:placeholder:text-gray-500"
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

        <p v-if="recipeAnalysisError" role="alert" tw-class="flex items-start gap-2 rounded-lg border border-red-200/70 bg-red-50/70 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-500/25 dark:bg-red-500/5 dark:text-red-300">
          <AlertTriangleIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span tw-class="min-w-0 wrap-break-word">{{ recipeAnalysisError }}</span>
        </p>
      </div>

      <!-- Analyzed Recipes List -->
      <div v-if="analyzedRecipes.length > 0" class="animate-in fade-in slide-in-from-top-2" tw-class="space-y-4 border-t border-gray-200/70 pt-5 duration-200 motion-reduce:animate-none dark:border-gray-800">
        <div tw-class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h3 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.RecipeImportTab__detected_recipes({ recipeCount: analyzedRecipes.length }) }}</h3>
          <ActionButton
            appearance="primary"
            icon-tone="blue"
            :disabled="selectedRecipes.length === 0"
            @click="handleImportRecipes"
            data-testid="recipe-import-button"
          >
            <FolderInputIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
            {{ lazyStrings.RecipeImportTab__import_selected() }}
          </ActionButton>
        </div>

        <div tw-class="space-y-3">
          <div
            v-for="item in analyzedRecipes"
            :key="idToRaw({ id: item.id })"
            tw-class="flex items-start gap-3 rounded-xl border border-gray-200/80 bg-gray-50/50 p-3.5 dark:border-gray-800 dark:bg-gray-800/30 sm:gap-4 sm:p-4"
          >
            <SettingsChoiceControl presentation="checkbox" tw-class="mt-0.5"><input
              type="checkbox"
              v-model="item.selected"
              :aria-label="item.newName || lazyStrings.RecipeImportTab__chat_group_name()"
            /></SettingsChoiceControl>
            <div tw-class="min-w-0 flex-1 space-y-3.5">
              <div tw-class="space-y-1.5">
                <label :for="`recipe-name-${idToRaw({ id: item.id })}`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.RecipeImportTab__chat_group_name() }}</label>
                <input
                  :id="`recipe-name-${idToRaw({ id: item.id })}`"
                  v-model="item.newName"
                  tw-class="block min-h-9 w-full rounded-lg border border-gray-200/80 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700/70 dark:bg-gray-800/55 dark:text-gray-100"
                  :placeholder="lazyStrings.RecipeImportTab__chat_group_name()"
                  data-testid="recipe-name-input"
                />
                <p v-if="item.recipe.description" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ item.recipe.description }}</p>
              </div>

              <div tw-class="space-y-1.5">
                <label :for="`recipe-model-${idToRaw({ id: item.id })}`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.RecipeImportTab__model_selection() }}</label>
                <ModelSelector
                  v-model="item.matchedModelId"
                  :input-id="`recipe-model-${idToRaw({ id: item.id })}`"
                  surface="settings"
                  refresh-visibility="hidden"
                  :models="getSortedModels({ matchedModelId: item.matchedModelId })"
                  :placeholder="lazyStrings.RecipeImportTab__use_default_model()"
                  allow-clear
                  :clear-label="lazyStrings.RecipeImportTab__use_default_model()"
                />
                <p v-if="item.matchError" tw-class="flex items-start gap-1.5 text-xs leading-relaxed text-red-600 dark:text-red-400">
                  <AlertTriangleIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span tw-class="min-w-0 wrap-break-word">{{ item.matchError }}</span>
                </p>
              </div>

              <div v-if="item.recipe.systemPrompt" tw-class="space-y-1 border-t border-gray-200/70 pt-3 dark:border-gray-700/60">
                <div tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.RecipeImportTab__system_prompt({ behavior: item.recipe.systemPrompt.behavior }) }}</div>
                <p tw-class="line-clamp-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ item.recipe.systemPrompt.content }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
