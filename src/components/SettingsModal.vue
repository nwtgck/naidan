<script setup lang="ts">
import type { ApplyDefaultModel } from '@/features/llama-cpp-browser/default-model';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { cloneEndpoint } from '@/01-models/endpoint';
import { provideHuggingFaceSession } from '@/features/llama-cpp-browser/hugging-face/session';
import { ref, watch, computed, nextTick, defineAsyncComponent, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { usePortableAppDownload } from '@/features/file-protocol-standalone/composables/usePortableAppDownload';
import { useToast } from '@/composables/useToast';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import { useLocalModelStart } from '@/composables/useLocalModelStart';
import type { Settings } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { ChatGroupRecipe } from '@/features/recipes/logic/recipe';
import { XIcon } from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// Lazily load tabs that are not visible by default, but prefetch them when idle.
const RecipeImportTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/recipes/components/RecipeImportTab.vue') });
const ProviderProfilesTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ProviderProfilesTab.vue') });
const LlamaCppBrowserManager = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue') });
const LlamaCppBrowserPerformanceEntry = defineAsyncComponent(() => import('@/features/llama-cpp-browser/components/LlamaCppBrowserPerformanceEntry.vue'));
const TransformersJsManager = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/transformers-js/components/TransformersJsManager.vue') });
const StorageTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./StorageTab.vue') });
const BinaryObjectsTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./BinaryObjectsTab.vue') });
const VolumeSettingsTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./VolumeSettingsTab.vue') });
const NaidanRpcTab = defineAsyncComponent(() => import('@/features/naidan-rpc-integration/components/NaidanRpcTab.vue'));
const DeveloperTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./DeveloperTab.vue') });
const AboutTab = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./AboutTab.vue') });
const GlobalToolsSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/tools/components/GlobalToolsSettings.vue') });

// IMPORTANT: ConnectionTab is the default tab, so we import it synchronously to ensure it's ready immediately when the modal opens.
import ConnectionTab from './ConnectionTab.vue';
import SettingsNavigation from './SettingsNavigation.vue';
import type { SettingsNavigationTab as Tab } from './settings-navigation';

import { useConfirm } from '@/composables/useConfirm'; // Import useConfirm
import { useLayout } from '@/composables/useLayout';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { naturalSort } from '@/utils/string';
import { lazyStrings, ensureStrings } from '@/strings';

const props = defineProps<{
  isOpen: boolean,
  suspended?: boolean,
  performanceLoading?: boolean,
  performanceError?: string,
  navigation?: 'route' | 'local',
  requestedTab?: string,
}>();
const usesLocalNavigation = computed(() => {
  const navigation = props.navigation;
  switch (navigation) {
  case 'local': return true;
  case 'route': case undefined: return false;
  default: {
    const exhaustive: never = navigation;
    return exhaustive;
  }
  }
});

const emit = defineEmits<{
  (e: 'close'): void,
  (e: 'openLlamaCppPerformance', defaultModel: string | undefined): void,
  (e: 'openModelSupportInvestigation', modelId: string): void,
}>();

const { settings, updateGlobalModelAndEndpoint, availableModels: rawAvailableModels, isFetchingModels } = useSettings();
const availableModels = computed(() => naturalSort({ values: Array.isArray(rawAvailableModels.value) ? rawAvailableModels.value : [] }));

const chatOrganization = useChatOrganization();
const { startLocalModel } = useLocalModelStart();
const { addToast } = useToast();
const { showConfirm } = useConfirm(); // Initialize useConfirm
const { setActiveFocusArea } = useLayout();
const { isFeatureEnabled } = useFeatureFlags();
provideHuggingFaceSession();
const route = useRoute();
const router = useRouter();

const isHostedMode = __BUILD_MODE_IS_HOSTED__;
const appVersion = __APP_VERSION__;
const portableAppDownload = usePortableAppDownload({ version: appVersion });

const form = ref<Settings>(JSON.parse(JSON.stringify(settings.value)));
const initialFormState = ref(JSON.stringify(pickConnectionFields({ settings: form.value })));
const connectionTabRef = ref<InstanceType<typeof ConnectionTab> | null>(null);

function pickConnectionFields({ settings }: { settings: Settings }) {
  return {
    endpoint: JSON.stringify(settings.endpoint),
    defaultModelId: settings.defaultModelId,
    titleGeneration: JSON.stringify(settings.titleGeneration),
    systemPrompt: settings.systemPrompt,
    lmParameters: JSON.stringify(settings.lmParameters),
  };
}

const applyLocalDefaultModel: ApplyDefaultModel = async ({ model, previous }) => {
  const result = await updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: model.modelId, expected: previous });
  switch (result) {
  case 'applied': {
    const endpoint = cloneEndpoint({ endpoint: settings.value.endpoint });
    form.value = { ...form.value, endpoint, defaultModelId: settings.value.defaultModelId };
    // Rebase only the two committed fields. Unrelated unsaved edits and their
    // original dirty baseline must survive switching the default model.
    const initial = JSON.parse(initialFormState.value);
    initialFormState.value = JSON.stringify({ ...initial, endpoint: JSON.stringify(endpoint), defaultModelId: settings.value.defaultModelId });
    break;
  }
  case 'changed': break;
  default: {
    const exhaustive: never = result;
    throw new Error(String(exhaustive));
  }
  }
  return result;
};

const hasUnsavedConnectionChanges = computed(() => {
  const current = pickConnectionFields({ settings: form.value });
  const initial = JSON.parse(initialFormState.value || '{}');
  return JSON.stringify(current) !== JSON.stringify(initial);
});

let creatingLocalChatGroup = false;
let localModelController: AbortController | undefined;
let modalRequestVersion = 0;
watch([() => props.isOpen, () => props.suspended, () => route.fullPath], () => {
  modalRequestVersion++;
}, { flush: 'sync' });
onUnmounted(() => {
  modalRequestVersion++;
  localModelController?.abort();
});

async function createLocalModelChatGroup({ model, signal }: { model: LocalModel, signal: AbortSignal }): Promise<void> {
  if (creatingLocalChatGroup || !props.isOpen || props.suspended || signal.aborted) {
    return;
  }
  creatingLocalChatGroup = true;
  const controller = new AbortController();
  localModelController = controller;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const stop = watch([() => props.isOpen, () => props.suspended, () => route.fullPath], abort, { flush: 'sync' });
  const isCurrent = () => !controller.signal.aborted && props.isOpen && !props.suspended;
  try {
    if (!await confirmDiscardConnectionChanges({ isCurrent }) || !isCurrent()) {
      return;
    }
    await startLocalModel({ model, signal: controller.signal });
  } finally {
    stop();
    signal.removeEventListener('abort', abort);
    localModelController = undefined;
    creatingLocalChatGroup = false;
  }
}

async function handleImportRecipes({ recipes }: { recipes: { newName: string, matchedModelId?: string, recipe: ChatGroupRecipe }[] }) {
  try {
    for (const item of recipes) {
      await chatOrganization.createChatGroup({
        name: item.newName,
        options: {
          modelId: item.matchedModelId,
          systemPrompt: item.recipe.systemPrompt,
          lmParameters: item.recipe.lmParameters ? {
            ...EMPTY_LM_PARAMETERS,
            ...item.recipe.lmParameters,
            reasoning: { effort: item.recipe.lmParameters.reasoning?.effort },
          } : EMPTY_LM_PARAMETERS,
        },
      });
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
const isRpcEnabled = computed(() => settings.value.experimental?.naidanRpc === 'enabled');
const isVolumesFeatureEnabled = computed(() => isFeatureEnabled({ feature: 'volume' }));
const localTab = ref<Tab>('connection');

function resolveLocalTab({ value }: { value: string | undefined }): Tab {
  switch (value) {
  case 'profiles': case 'provider-profiles': return 'profiles';
  case 'transformers_js': case 'transformers-js': return 'transformers_js';
  case 'llama_cpp_browser': case 'llama-cpp-browser': return 'llama_cpp_browser';
  case 'binary_objects': case 'binary-objects': return 'binary_objects';
  case 'naidan_rpc': case 'naidan-rpc': return isRpcEnabled.value ? 'naidan_rpc' : 'connection';
  case 'volumes': return isVolumesFeatureEnabled.value ? 'volumes' : 'connection';
  case 'tools': case 'recipes': case 'storage': case 'developer': case 'about': return value;
  default: return 'connection';
  }
}

watch(() => props.requestedTab, value => {
  localTab.value = resolveLocalTab({ value });
}, { immediate: true });
const activeTab = computed({
  get: () => {
    if (usesLocalNavigation.value) {
      return resolveLocalTab({ value: localTab.value });
    }
    const queryTab = route.query.settings as string;
    if (queryTab) {
      if (queryTab === 'naidan-rpc' || queryTab === 'naidan_rpc') {
        return isRpcEnabled.value ? 'naidan_rpc' : 'connection';
      }
      if (queryTab === 'provider-profiles') {
        return 'profiles';
      }
      if (queryTab === 'transformers-js') {
        return 'transformers_js';
      }
      if (queryTab === 'llama-cpp-browser') {
        return 'llama_cpp_browser';
      }
      if (queryTab === 'binary-objects') {
        return 'binary_objects';
      }
      if (queryTab === 'volumes' && !isVolumesFeatureEnabled.value) {
        return 'connection';
      }
      return (queryTab as Tab);
    }
    const tab = (route.params as { tab?: string }).tab;
    if (tab === 'naidan-rpc' || tab === 'naidan_rpc') {
      return isRpcEnabled.value ? 'naidan_rpc' : 'connection';
    }
    if (tab === 'provider-profiles') {
      return 'profiles';
    }
    if (tab === 'transformers-js') {
      return 'transformers_js';
    }
    if (tab === 'llama-cpp-browser') {
      return 'llama_cpp_browser';
    }
    if (tab === 'binary-objects') {
      return 'binary_objects';
    }
    if (tab === 'volumes' && !isVolumesFeatureEnabled.value) {
      return 'connection';
    }
    return (tab as Tab) || 'connection';
  },
  set: (val) => {
    if (usesLocalNavigation.value) {
      localTab.value = val;
      return;
    }
    const pathMap: Record<string, string> = {
      naidan_rpc: 'naidan-rpc',
      profiles: 'provider-profiles',
      transformers_js: 'transformers-js',
      llama_cpp_browser: 'llama-cpp-browser',
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

async function confirmDiscardConnectionChanges({ isCurrent }: { isCurrent: () => boolean }): Promise<boolean> {
  if (hasUnsavedConnectionChanges.value) {
    const options = {
      title: await ensureStrings.SettingsModal__discard_unsaved_changes(),
      message: await ensureStrings.SettingsModal__discard_unsaved_connection_changes(),
      confirmButtonText: await ensureStrings.SettingsModal__discard(),
      cancelButtonText: await ensureStrings.SettingsModal__keep_editing(),
    };
    return isCurrent() ? showConfirm(options) : false;
  }
  return true;
}

async function handleCancel() {
  const version = modalRequestVersion;
  const isCurrent = () => props.isOpen && version === modalRequestVersion;
  if (await confirmDiscardConnectionChanges({ isCurrent }) && isCurrent()) {
    emit('close');
  }
}

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
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" data-testid="settings-modal" tw-class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-2 md:p-6">
      <div class="modal-content-zoom" tw-class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-[95vw] h-[95vh] md:h-[90vh] overflow-hidden flex flex-col md:flex-row border border-gray-100 dark:border-gray-800 relative">
        <SettingsNavigation
          :active-tab="activeTab"
          :is-volumes-feature-enabled="isVolumesFeatureEnabled"
          :is-rpc-enabled="isRpcEnabled"
          :is-hosted-mode="isHostedMode"
          :portable-app-download="portableAppDownload"
          @select="activeTab = $event"
        >
          <template #close>
            <button
              type="button"
              @click="handleCancel"
              :aria-label="lazyStrings.SHARED__cancel()"
              tw-class="absolute top-[10px] right-3 z-10 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 md:top-4 md:right-4 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              data-testid="setting-close-x"
            >
              <XIcon aria-hidden="true" tw-class="h-5 w-5" />
            </button>
          </template>
        </SettingsNavigation>

        <!-- Main Content Area -->
        <main data-settings-main tw-class="flex-1 flex flex-col min-w-0 min-h-0 bg-white dark:bg-gray-900 relative">
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
          <div v-else tw-class="flex-1 overflow-y-auto min-h-0 overscroll-contain">
            <div tw-class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">

              <!-- Global Tools Tab -->
              <GlobalToolsSettings v-if="activeTab === 'tools'" />

              <!-- Provider Profiles Tab -->
              <ProviderProfilesTab
                v-if="activeTab === 'profiles'"
                v-model:profiles="form.providerProfiles"
                @go-to-connection="activeTab = 'connection'"
              />

              <!-- Transformers.js Tab -->
              <div v-if="activeTab === 'transformers_js'" tw-class="max-w-4xl mx-auto">
                <TransformersJsManager presentation="settings" @open-model-support-investigation="emit('openModelSupportInvestigation', $event)" />
              </div>
              <div v-if="activeTab === 'llama_cpp_browser'" tw-class="max-w-4xl mx-auto">
                <LlamaCppBrowserManager presentation="settings" :suspended="props.suspended" :default-model="{ endpoint: settings.endpoint, modelId: settings.defaultModelId }" :apply-default-model="applyLocalDefaultModel" :create-chat-group="createLocalModelChatGroup" />
                <LlamaCppBrowserPerformanceEntry :loading="props.performanceLoading === true" :error="props.performanceError" tw-class="mt-5" @open="emit('openLlamaCppPerformance', settings.endpoint.type === 'llama_cpp_browser' ? settings.defaultModelId : undefined)" />
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

              <NaidanRpcTab v-if="activeTab === 'naidan_rpc' && isRpcEnabled" />

              <!-- Developer Tab -->
              <DeveloperTab
                v-if="activeTab === 'developer'"
                :storage-type="form.storageType"
                @open-model-support-investigation="emit('openModelSupportInvestigation', $event)"
              />

              <!-- About Tab -->
              <AboutTab v-if="activeTab === 'about'" :visibility="props.suspended ? 'hidden' : 'visible'" />
            </div>
          </div>
        </main>
      </div>
    </div>
  </Transition>
</template>


<style scoped>
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
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
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
  from {
    transform: translateY(15px);
  }
  to {
    transform: translateY(0);
  }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom;
}
</style>
