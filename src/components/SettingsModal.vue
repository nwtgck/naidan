<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useToast } from '../composables/useToast';
import type { Settings } from '../models/types';
import { ChatGroupRecipeSchema } from '../models/recipe';
import type { ChatGroupRecipe } from '../models/recipe';
import { parseConcatenatedJson } from '../utils/json-stream-parser';
import { matchRecipeModels } from '../utils/recipe-matcher';
import { 
  X, Globe, 
  Database, Settings2, BookmarkPlus,
  Cpu, Info,
  ChefHat,
  Github, ExternalLink, Download
} from 'lucide-vue-next';
import RecipeImportTab from './RecipeImportTab.vue';
import ProviderProfilesTab from './ProviderProfilesTab.vue';
import StorageTab from './StorageTab.vue';
import DeveloperTab from './DeveloperTab.vue';
import AboutTab from './AboutTab.vue';
import ConnectionTab from './ConnectionTab.vue';
import { useConfirm } from '../composables/useConfirm'; // Import useConfirm
import { naturalSort } from '../utils/string';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { settings, availableModels: rawAvailableModels, isFetchingModels } = useSettings();
const availableModels = computed(() => naturalSort(Array.isArray(rawAvailableModels.value) ? rawAvailableModels.value : []));

const chatStore = useChat();
const { addToast } = useToast();
const { showConfirm } = useConfirm(); // Initialize useConfirm

const isHostedMode = __BUILD_MODE_IS_HOSTED__;

const form = ref<Settings>(JSON.parse(JSON.stringify(settings.value)));
const initialFormState = ref('');
const connectionTabRef = ref<InstanceType<typeof ConnectionTab> | null>(null);

function pickConnectionFields(s: Settings) {
  return {
    endpointType: s.endpointType,
    endpointUrl: s.endpointUrl,
    endpointHttpHeaders: JSON.stringify(s.endpointHttpHeaders),
    defaultModelId: s.defaultModelId,
    titleModelId: s.titleModelId,
    autoTitleEnabled: s.autoTitleEnabled,
    systemPrompt: s.systemPrompt,
    lmParameters: JSON.stringify(s.lmParameters),
  };
}

const hasUnsavedConnectionChanges = computed(() => {
  const current = pickConnectionFields(form.value);
  const initial = JSON.parse(initialFormState.value || '{}');
  return JSON.stringify(current) !== JSON.stringify(initial);
});

async function handleImportRecipes(recipes: { newName: string; matchedModelId?: string; recipe: ChatGroupRecipe }[]) {
  try {
    for (const item of recipes) {
      await chatStore.createChatGroup(item.newName, {
        modelId: item.matchedModelId,
        systemPrompt: item.recipe.systemPrompt,
        lmParameters: item.recipe.lmParameters,
      });
    }

    addToast({
      message: `Successfully imported ${recipes.length} recipes as chat groups`,
      duration: 3000,
    });
  } catch (err) {
    console.error('Failed to import recipes:', err);
    addToast({
      message: `Failed to import recipes: ${err instanceof Error ? err.message : String(err)}`,
      duration: 5000,
    });
  }
}

// Tab State
type Tab = 'connection' | 'recipes' | 'profiles' | 'storage' | 'developer' | 'about';
const activeTab = ref<Tab>('connection');

async function handleCancel() {
  if (hasUnsavedConnectionChanges.value) {
    const confirmed = await showConfirm({
      title: 'Discard Unsaved Changes?',
      message: 'You have unsaved changes in your connection settings. Are you sure you want to discard them?',
      confirmButtonText: 'Discard',
      cancelButtonText: 'Keep Editing',
    });
    if (confirmed) {
      emit('close');
    }
  } else {
    emit('close');
  }
}

// Recipes State
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
    const match = matchRecipeModels(recipe.models, availableModels.value);

    newAnalyzed.push({
      id: crypto.randomUUID(),
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

// Watch for modal open to reset form
watch(() => props.isOpen, async (open) => {
  if (open) {
    form.value = JSON.parse(JSON.stringify(settings.value)) as Settings;
    initialFormState.value = JSON.stringify(pickConnectionFields(form.value));
    
    await nextTick();
    if (connectionTabRef.value) {
      connectionTabRef.value.fetchModels();
    }
  }
});

</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" data-testid="settings-modal" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-2 md:p-6">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-[95vw] h-[95vh] md:h-[90vh] overflow-hidden flex flex-col md:flex-row border border-gray-100 dark:border-gray-800 relative modal-content-zoom">
        <!-- Persistent Close Button (Top Right) -->
        <button 
          @click="handleCancel"
          class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
          data-testid="setting-close-x"
        >
          <X class="w-5 h-5" />
        </button>

        <!-- Sidebar (Tabs) -->
        <aside class="w-full md:w-72 flex-shrink-0 bg-gray-50/50 dark:bg-black/20 border-b md:border-b-0 md:border-r border-gray-100 dark:border-gray-800/50 flex flex-col min-h-0 transition-colors">
          <!-- Header -->
          <div class="p-6 border-b border-gray-100 dark:border-gray-800/50 flex items-center gap-3 shrink-0">
            <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
              <Settings2 class="w-5 h-5 text-blue-600" />
            </div>
            <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Settings</h2>
          </div>

          <!-- Navigation -->
          <nav class="flex-1 overflow-x-auto md:overflow-y-auto p-4 flex md:flex-col gap-1.5 no-scrollbar min-h-0">
            <button 
              @click="activeTab = 'connection'"
              class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'connection' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-connection"
            >
              <Globe class="w-4 h-4" />
              Connection
            </button>
            <button 
              @click="activeTab = 'profiles'"
              class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'profiles' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-profiles"
            >
              <BookmarkPlus class="w-4 h-4" />
              Provider Profiles
            </button>
            <button 
              @click="activeTab = 'recipes'"
              class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'recipes' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-recipes"
            >
              <ChefHat class="w-4 h-4" />
              Recipes
            </button>
            <button 
              @click="activeTab = 'storage'"
              class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'storage' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-storage"
            >
              <Database class="w-4 h-4" />
              Storage
            </button>
            <button 
              @click="activeTab = 'developer'"
              class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'developer' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-developer"
            >
              <Cpu class="w-4 h-4" />
              Developer
            </button>
            <button 
              @click="activeTab = 'about'"
              class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'about' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-about"
            >
              <Info class="w-4 h-4" />
              About
            </button>
          </nav>

          <!-- GitHub & Download Footer -->
          <div class="p-4 border-t border-gray-100 dark:border-gray-800/50 mt-auto space-y-2">
            <a 
              href="https://github.com/nwtgck/naidan" 
              target="_blank" 
              rel="noopener noreferrer"
              class="flex items-center gap-3 px-4 py-3 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700 transition-all group no-underline shadow-sm"
            >
              <Github class="w-4 h-4 text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white transition-colors" />
              <div class="flex-1 min-w-0 text-left">
                <div class="text-[11px] font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1">
                  GitHub Repository
                  <span class="text-[9px] opacity-80 font-bold uppercase tracking-tighter bg-amber-50 dark:bg-amber-900/20 px-1 rounded text-amber-600 dark:text-amber-400">External</span>
                </div>
                <div class="text-[10px] text-gray-500/70 dark:text-gray-400/60 font-medium">View source code</div>
              </div>
              <ExternalLink class="w-3 h-3 text-gray-400 opacity-50" />
            </a>

            <a 
              v-if="isHostedMode"
              href="./naidan-standalone.zip" 
              download="naidan-standalone.zip"
              class="flex items-center gap-3 px-4 py-3 bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-900/30 rounded-xl transition-all group no-underline"
              data-testid="sidebar-download-button"
            >
              <div class="p-2 bg-green-100 dark:bg-green-800/50 rounded-lg text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
                <Download class="w-4 h-4" />
              </div>
              <div class="flex-1 min-w-0 text-left">
                <div class="text-xs font-bold text-green-800 dark:text-green-300">Offline Standalone</div>
                <div class="text-[10px] text-green-600/70 dark:text-green-400/60 font-medium truncate">Runs locally via file://</div>
              </div>
            </a>
          </div>
        </aside>

        <!-- Main Content Area -->
        <main class="flex-1 flex flex-col min-w-0 min-h-0 bg-white dark:bg-gray-900 relative">
          <ConnectionTab 
            v-if="activeTab === 'connection'"
            ref="connectionTabRef"
            v-model="form"
            :available-models="availableModels"
            :is-fetching-models="isFetchingModels"
            :has-unsaved-changes="hasUnsavedConnectionChanges"
            @save="initialFormState = JSON.stringify(pickConnectionFields(form))"
            @go-to-profiles="activeTab = 'profiles'"
          />
          <div v-else class="flex-1 overflow-y-auto min-h-0">
            <div class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">

              <!-- Provider Profiles Tab -->
              <ProviderProfilesTab 
                v-if="activeTab === 'profiles'"
                v-model:profiles="form.providerProfiles"
                @go-to-connection="activeTab = 'connection'"
              />

              <!-- Recipes Tab -->
              <RecipeImportTab 
                v-if="activeTab === 'recipes'"
                :available-models="availableModels"
                @import="handleImportRecipes"
                @toast="(msg: string, dur?: number) => addToast({ message: msg, duration: dur })"
              />

              <!-- Storage Tab -->
              <StorageTab 
                v-if="activeTab === 'storage'"
                v-model:storage-type="form.storageType"
                @close="emit('close')"
              />

              <!-- Developer Tab -->
              <DeveloperTab 
                v-if="activeTab === 'developer'" 
                :storage-type="form.storageType" 
              />

              <!-- About Tab -->
              <AboutTab v-if="activeTab === 'about'" />
            </div>
          </div>
        </main>
      </div>
    </div>
  </Transition>
</template>


<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* Modal Transition */
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

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { 
    opacity: 0; 
    transform: scale(0.9); 
  }
  to { 
    opacity: 1; 
    transform: scale(1); 
  }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(15px); }
  to { transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom;
}
</style>

