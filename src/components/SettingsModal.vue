<script setup lang="ts">
import { generateOpaqueId } from '@/utils/id';
import { ref, watch, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import type { Settings } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import { ChatGroupRecipeSchema } from '@/models/recipe';
import type { ChatGroupRecipe } from '@/models/recipe';
import { parseConcatenatedJson } from '@/utils/json-stream-parser';
import { matchRecipeModels } from '@/utils/recipe-matcher';
import {
  XIcon, GlobeIcon,
  DatabaseIcon, Settings2Icon, BookmarkPlusIcon,
  CpuIcon, InfoIcon,
  ChefHatIcon,
  DownloadIcon, BrainCircuitIcon,
  FolderIcon,
  FileIcon, WrenchIcon,
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// Lazily load tabs that are not visible by default, but prefetch them when idle.
const RecipeImportTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./RecipeImportTab.vue') });
const ProviderProfilesTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ProviderProfilesTab.vue') });
const TransformersJsManager = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./TransformersJsManager.vue') });
const StorageTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./StorageTab.vue') });
const BinaryObjectsTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./BinaryObjectsTab.vue') });
const VolumeSettingsTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./VolumeSettingsTab.vue') });
const DeveloperTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./DeveloperTab.vue') });
const AboutTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./AboutTab.vue') });
const GlobalToolsSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./GlobalToolsSettings.vue') });

// IMPORTANT: ConnectionTab is the default tab, so we import it synchronously to ensure it's ready immediately when the modal opens.
import ConnectionTab from './ConnectionTab.vue';
import ThemeToggle from './ThemeToggle.vue';
import LanguageSelector from './LanguageSelector.vue';

import { useConfirm } from '@/composables/useConfirm'; // Import useConfirm
import { useLayout } from '@/composables/useLayout';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { naturalSort } from '@/utils/string';
import { lazyStrings, ensureStrings } from '@/strings';

const props = defineProps<{
  isOpen: boolean,
}>();

const emit = defineEmits<{
  (e: 'close'): void,
}>();

const { settings, availableModels: rawAvailableModels, isFetchingModels } = useSettings();
const availableModels = computed(() => naturalSort({ values: Array.isArray(rawAvailableModels.value) ? rawAvailableModels.value : [] }));

const chatOrganization = useChatOrganization();
const { addToast } = useToast();
const { showConfirm } = useConfirm(); // Initialize useConfirm
const { setActiveFocusArea } = useLayout();
const { isFeatureEnabled } = useFeatureFlags();
const route = useRoute();
const router = useRouter();

const isHostedMode = __BUILD_MODE_IS_HOSTED__;
const appVersion = __APP_VERSION__;

const form = ref<Settings>(JSON.parse(JSON.stringify(settings.value)));
const initialFormState = ref(JSON.stringify(pickConnectionFields({ settings: form.value })));
const connectionTabRef = ref<InstanceType<typeof ConnectionTab> | null>(null);

function pickConnectionFields({ settings }: { settings: Settings }) {
  return {
    endpointType: settings.endpointType,
    endpointUrl: settings.endpointUrl,
    endpointHttpHeaders: JSON.stringify(settings.endpointHttpHeaders),
    defaultModelId: settings.defaultModelId,
    titleModelId: settings.titleModelId,
    autoTitleEnabled: settings.autoTitleEnabled,
    systemPrompt: settings.systemPrompt,
    lmParameters: JSON.stringify(settings.lmParameters),
  };
}

const hasUnsavedConnectionChanges = computed(() => {
  const current = pickConnectionFields({ settings: form.value });
  const initial = JSON.parse(initialFormState.value || '{}');
  return JSON.stringify(current) !== JSON.stringify(initial);
});

async function handleImportRecipes({ recipes }: { recipes: { newName: string, matchedModelId?: string, recipe: ChatGroupRecipe }[] }) {
  try {
    for (const item of recipes) {
      await chatOrganization.createChatGroup({ name: item.newName, options: {
        modelId: item.matchedModelId,
        systemPrompt: item.recipe.systemPrompt,
        lmParameters: item.recipe.lmParameters ? {
          ...EMPTY_LM_PARAMETERS,
          ...item.recipe.lmParameters,
          reasoning: { effort: item.recipe.lmParameters.reasoning?.effort },
        } : EMPTY_LM_PARAMETERS,
      } });
    }

    addToast({
      message: await ensureStrings.SettingsModal__successfully_imported_recipes_as_chat_groups({ recipeCount: recipes.length }),
      duration: 3000,
    });
  } catch (err) {
    console.error('Failed to import recipes:', err);
    addToast({
      message: await ensureStrings.SettingsModal__failed_to_import_recipes({ errorMessage: err instanceof Error ? err.message : String(err) }),
      duration: 5000,
    });
  }
}

// Tab State
type Tab = 'connection' | 'tools' | 'recipes' | 'profiles' | 'transformers_js' | 'storage' | 'binary_objects' | 'volumes' | 'developer' | 'about';
const isVolumesFeatureEnabled = computed(() => isFeatureEnabled({ feature: 'volume' }));
const activeTab = computed({
  get: () => {
    const queryTab = route.query.settings as string;
    if (queryTab) {
      if (queryTab === 'provider-profiles') return 'profiles';
      if (queryTab === 'transformers-js') return 'transformers_js';
      if (queryTab === 'binary-objects') return 'binary_objects';
      if (queryTab === 'volumes' && !isVolumesFeatureEnabled.value) return 'connection';
      return (queryTab as Tab);
    }
    const tab = (route.params as { tab?: string }).tab;
    if (tab === 'provider-profiles') return 'profiles';
    if (tab === 'transformers-js') return 'transformers_js';
    if (tab === 'binary-objects') return 'binary_objects';
    if (tab === 'volumes' && !isVolumesFeatureEnabled.value) return 'connection';
    return (tab as Tab) || 'connection';
  },
  set: (val) => {
    const pathMap: Record<string, string> = {
      profiles: 'provider-profiles',
      transformers_js: 'transformers-js',
      binary_objects: 'binary-objects',
    };
    const mappedVal = pathMap[val] || val;
    if (route.query.settings || !route.path.startsWith('/settings')) {
      router.push({ query: { ...route.query, settings: mappedVal } });
    } else {
      router.push(`/settings/${mappedVal}`);
    }
  },
});

async function handleCancel() {
  if (hasUnsavedConnectionChanges.value) {
    const [title, message, confirmButtonText, cancelButtonText] = await Promise.all([
      ensureStrings.SettingsModal__discard_unsaved_changes(),
      ensureStrings.SettingsModal__discard_unsaved_connection_changes(),
      ensureStrings.SettingsModal__discard(),
      ensureStrings.SettingsModal__keep_editing(),
    ]);
    const confirmed = await showConfirm({ title, message, confirmButtonText, cancelButtonText });
    if (confirmed) {
      emit('close');
    }
  } else {
    emit('close');
  }
}

// Recipes State
interface AnalyzedRecipe {
  id: string,
  recipe: ChatGroupRecipe,
  selected: boolean,
  matchedModelId?: string,
  matchError?: string,
  newName: string,
}

const recipeJsonInput = ref('');
const analyzedRecipes = ref<AnalyzedRecipe[]>([]);
const recipeAnalysisError = ref<string | null>(null);

async function handleAnalyzeRecipes(): Promise<void> {
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
      recipeAnalysisError.value = await ensureStrings.SettingsModal__parse_error({ errorMessage: result.error });
      continue;
    }

    const validation = ChatGroupRecipeSchema.safeParse(result.data);
    if (!validation.success) {
      recipeAnalysisError.value = await ensureStrings.SettingsModal__validation_error({ errorMessage: validation.error.message });
      continue;
    }

    const recipe = validation.data;
    const match = matchRecipeModels({ recipeModels: recipe.models, availableModelIds: availableModels.value });

    newAnalyzed.push({
      id: generateOpaqueId(),
      recipe,
      selected: true,
      matchedModelId: match.modelId,
      matchError: match.error,
      newName: recipe.name,
    });
  }

  if (newAnalyzed.length === 0 && !recipeAnalysisError.value) {
    recipeAnalysisError.value = await ensureStrings.SettingsModal__no_valid_recipes_found_in_input();
  }

  analyzedRecipes.value = newAnalyzed;
}

// Automatically analyze on input change
watch(recipeJsonInput, () => {
  void handleAnalyzeRecipes();
});

// Watch for modal open to reset form
watch(() => props.isOpen, async (open) => {
  if (open) {
    setActiveFocusArea({ area: 'settings' });
    form.value = JSON.parse(JSON.stringify(settings.value)) as Settings;
    initialFormState.value = JSON.stringify(pickConnectionFields({ settings: form.value }));

    await nextTick();
    if (connectionTabRef.value) {
      connectionTabRef.value.fetchModels();
    }
  } else {
    setActiveFocusArea({ area: 'chat' });
  }
});



defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
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
          <XIcon class="w-5 h-5" />
        </button>

        <!-- Sidebar (Tabs) -->
        <aside class="w-full md:w-72 flex-shrink-0 bg-gray-50/50 dark:bg-black/20 border-b md:border-b-0 md:border-r border-gray-100 dark:border-gray-800/50 flex flex-col min-h-0 transition-colors">
          <!-- Header -->
          <div class="p-4 md:p-6 border-b border-gray-100 dark:border-gray-800/50 flex items-center justify-between gap-3 shrink-0">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                <Settings2Icon class="w-4 h-4 md:w-5 md:h-5 text-blue-600" />
              </div>
              <h2 class="text-base md:text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.SettingsModal__settings() }}</h2>
            </div>
            <LanguageSelector />
          </div>

          <!-- Navigation -->
          <nav class="flex-1 overflow-x-auto md:overflow-y-auto p-3 md:p-4 flex md:flex-col gap-1.5 no-scrollbar min-h-0 overscroll-contain">
            <button
              @click="activeTab = 'connection'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'connection' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-connection"
            >
              <GlobeIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__connection() }}
            </button>
            <button
              @click="activeTab = 'tools'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'tools' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-tools"
            >
              <WrenchIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__tools() }}
            </button>
            <button
              @click="activeTab = 'profiles'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'profiles' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-profiles"
            >
              <BookmarkPlusIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__provider_profiles() }}
            </button>
            <button
              @click="activeTab = 'transformers_js'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'transformers_js' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-purple-500/5 text-purple-600 dark:text-purple-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-transformers-js"
            >
              <BrainCircuitIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__transformers_js() }}
            </button>
            <button
              @click="activeTab = 'recipes'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'recipes' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-recipes"
            >
              <ChefHatIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__recipes() }}
            </button>
            <button
              @click="activeTab = 'storage'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'storage' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-storage"
            >
              <DatabaseIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__storage() }}
            </button>
            <button
              @click="activeTab = 'binary_objects'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'binary_objects' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-files"
            >
              <FileIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__files() }}
            </button>
            <button
              v-if="isVolumesFeatureEnabled"
              @click="activeTab = 'volumes'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'volumes' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-volumes"
            >
              <FolderIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__folders() }}
            </button>
            <button
              @click="activeTab = 'developer'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'developer' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-developer"
            >
              <CpuIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__developer() }}
            </button>
            <button
              @click="activeTab = 'about'"
              class="flex items-center gap-2.5 md:gap-3 px-3.5 py-2.5 md:px-4 md:py-3.5 rounded-xl text-xs md:text-sm font-bold transition-colors whitespace-nowrap text-left border"
              :class="activeTab === 'about' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
              data-testid="tab-about"
            >
              <InfoIcon class="w-4 h-4" />
              {{ lazyStrings.SettingsModal__about() }}
            </button>
          </nav>

          <!-- Settings Footer -->
          <div class="p-3 md:p-4 border-t border-gray-100 dark:border-gray-800/50 mt-auto flex items-center gap-3">
            <div class="w-28 shrink-0">
              <ThemeToggle />
            </div>

            <a
              v-if="isHostedMode"
              href="./naidan-standalone.zip"
              :download="'naidan-standalone-v' + appVersion + '.zip'"
              class="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-900/30 rounded-xl transition-all group no-underline"
              data-testid="sidebar-download-button"
            >
              <DownloadIcon class="w-4 h-4 text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform shrink-0" />
              <div class="text-[10px] md:text-xs font-bold text-green-800 dark:text-green-300 truncate">
                {{ lazyStrings.SettingsModal__standalone() }}
              </div>
            </a>
          </div>
        </aside>

        <!-- Main Content Area -->
        <main data-settings-main class="flex-1 flex flex-col min-w-0 min-h-0 bg-white dark:bg-gray-900 relative">
          <ConnectionTab
            v-if="activeTab === 'connection'"
            ref="connectionTabRef"
            v-model="form"
            :available-models="availableModels"
            :is-fetching-models="isFetchingModels"
            :has-unsaved-changes="hasUnsavedConnectionChanges"
            @save="initialFormState = JSON.stringify(pickConnectionFields({ settings: form }))"
            @go-to-profiles="activeTab = 'profiles'"
            @go-to-transformers-js="activeTab = 'transformers_js'"
          />
          <div v-else class="flex-1 overflow-y-auto min-h-0 overscroll-contain">
            <div class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">

              <!-- Global Tools Tab -->
              <GlobalToolsSettings v-if="activeTab === 'tools'" />

              <!-- Provider Profiles Tab -->
              <ProviderProfilesTab
                v-if="activeTab === 'profiles'"
                v-model:profiles="form.providerProfiles"
                @go-to-connection="activeTab = 'connection'"
              />

              <!-- Transformers.js Tab -->
              <div v-if="activeTab === 'transformers_js'" class="max-w-4xl mx-auto">
                <TransformersJsManager />
              </div>

              <!-- Recipes Tab -->
              <RecipeImportTab
                v-if="activeTab === 'recipes'"
                :available-models="availableModels"
                @import="handleImportRecipes({ recipes: $event })"
                @toast="(msg: string, dur?: number) => addToast({ message: msg, duration: dur })"
              />

              <!-- Storage Tab -->
              <StorageTab
                v-if="activeTab === 'storage'"
                v-model:storage-type="form.storageType"
                @close="emit('close')"
              />

              <!-- Binary Objects Tab -->
              <BinaryObjectsTab v-if="activeTab === 'binary_objects'" />

              <!-- Volume Settings Tab -->
              <VolumeSettingsTab v-if="activeTab === 'volumes' && isVolumesFeatureEnabled" />

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
