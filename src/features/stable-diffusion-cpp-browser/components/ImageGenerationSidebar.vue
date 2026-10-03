<script setup lang="ts">
import { computed } from 'vue';
import { useConfirm } from '@/composables/useConfirm';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { SquarePenIcon, ArrowLeftIcon, SettingsIcon, PencilIcon, FolderOpenIcon, SlidersHorizontalIcon, ImageIcon, Trash2Icon } from 'lucide-vue-next';
import SidebarHeader from '@/components/SidebarHeader.vue';
import SidebarDebugControls from '@/components/SidebarDebugControls.vue';
import { useLayout } from '@/composables/useLayout';
import { usePrompt } from '@/composables/usePrompt';
import { ensureStrings, lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { ImageGenerationSession } from '@/01-models/image-generation';
import type { ImageGenerationNavigation } from '@/features/stable-diffusion-cpp-browser/session/navigation';
const props = defineProps<{ navigation: ImageGenerationNavigation }>();
const { isSidebarOpen, toggleSidebar } = useLayout();
const { showPrompt } = usePrompt();
const router = useRouter(), route = useRoute();
const { showConfirm } = useConfirm();
const isGeneration = computed(() => route.path.replace(/\/+$/, '') === '/image-generation' || route.path.startsWith('/image-generation/session/'));
async function remove({ session }: { session: ImageGenerationSession }): Promise<void> {
  const view = props.navigation.view, storeId = view?.store.value?.storeId;
  if (!view || !storeId || view.busy.value) return;
  if (!await showConfirm({ title: await ensureStrings.imageGeneration__delete_session(), message: await ensureStrings.imageGeneration__delete_session_notice({ title: session.title }), confirmButtonVariant: 'danger', confirmButtonText: await ensureStrings.imageGeneration__delete_session() })) return;
  if (view.store.value?.storeId !== storeId) return;
  const selected = view.selectedSessionId.value === session.id;
  if (await view.deleteSession({ sessionId: session.id }) && selected) props.navigation.openGeneration();
}
async function rename({ session }: { session: ImageGenerationSession }): Promise<void> {
  const title = await showPrompt({ title: await ensureStrings.imageGeneration__rename_session(), defaultValue: session.title });
  if (typeof title === 'string') await props.navigation.view?.renameSession({ sessionId: session.id, title });
}
async function select({ session }: { session: ImageGenerationSession }): Promise<void> {
  await props.navigation.view?.selectSession({ sessionId: session.id }); props.navigation.openGeneration();
}
async function create(): Promise<void> {
  await props.navigation.view?.newSession({ preserveDraft: false }); props.navigation.openGeneration();
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <nav tw-class="flex flex-col h-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 select-none transition-colors" :aria-label="lazyStrings.imageGeneration__sessions()" data-testid="image-generation-sidebar">
    <SidebarHeader :expanded="isSidebarOpen" @toggle="toggleSidebar" />
    <div :tw-class="['py-2', isSidebarOpen ? 'px-4' : 'px-1']">
      <button type="button" @click="create" :disabled="navigation.view?.busy.value || !navigation.view?.available.value" :title="lazyStrings.imageGeneration__new_session()" :aria-label="lazyStrings.imageGeneration__new_session()" data-testid="workspace-new-session" :tw-class="['flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all font-bold shadow-lg shadow-blue-500/20 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', isSidebarOpen ? 'w-full px-3 py-2 text-xs' : 'w-8 h-8']"><SquarePenIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen" tw-class="whitespace-nowrap overflow-hidden">{{ lazyStrings.imageGeneration__new_session() }}</span></button>
    </div>
    <div v-if="isSidebarOpen" tw-class="flex-1 min-h-0 overflow-y-auto px-2 space-y-1">
      <p v-if="!navigation.view?.sessions.value.length" tw-class="px-3 py-4 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__no_sessions() }}</p>
      <div v-for="session in navigation.view?.sessions.value ?? []" :key="idToRaw({ id: session.id })" :tw-class="['flex items-center gap-1 rounded-xl group', navigation.view?.selectedSessionId.value === session.id ? 'bg-white dark:bg-gray-800 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700' : 'hover:bg-gray-100 dark:hover:bg-gray-800/50']">
        <button type="button" @click="select({ session })" :disabled="navigation.view?.busy.value || session.state === 'deleting'" :aria-current="isGeneration && navigation.view?.selectedSessionId.value === session.id ? 'page' : undefined" tw-class="min-w-0 flex-1 px-3 py-3 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          <span tw-class="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">{{ session.title }}<span v-if="session.state === 'deleting'" tw-class="ml-1 text-xs text-amber-600 dark:text-amber-400"> · {{ lazyStrings.imageGeneration__session_deletion_pending() }}</span></span>
          <span tw-class="block mt-1 text-[10px] text-gray-400">{{ new Date(session.updatedAt).toLocaleDateString() }}</span>
        </button>
        <button type="button" @click="rename({ session })" :disabled="navigation.view?.busy.value || session.state === 'deleting'" :aria-label="lazyStrings.imageGeneration__rename_session()" tw-class="mr-1 p-2 text-gray-400 hover:text-blue-600 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><PencilIcon tw-class="w-3.5 h-3.5" /></button>
        <button type="button" @click="remove({ session })" :disabled="navigation.view?.busy.value" :aria-label="lazyStrings.imageGeneration__delete_session()" data-testid="generation-delete-session" tw-class="mr-1 p-2 text-gray-400 hover:text-red-600 rounded-lg disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><Trash2Icon tw-class="w-3.5 h-3.5" /></button>
      </div>
    </div>
    <div v-else tw-class="flex-1" />
    <div :tw-class="['border-t border-gray-100 dark:border-gray-800 space-y-1', isSidebarOpen ? 'p-3' : 'p-1']">
      <button type="button" @click="navigation.openGeneration" data-testid="workspace-nav-generate" :aria-current="isGeneration ? 'page' : undefined" :title="lazyStrings.stableDiffusionCppBrowser__generate()" :tw-class="['flex items-center gap-2 w-full rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', isGeneration ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800']"><ImageIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.stableDiffusionCppBrowser__generate() }}</span></button>
      <button type="button" @click="navigation.openModels" data-testid="workspace-nav-models" :aria-current="route.path.replace(/\/+$/, '') === '/image-generation/models' ? 'page' : undefined" :title="lazyStrings.ImageGenerationLab__models()" :tw-class="['flex items-center gap-2 w-full rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', route.path.replace(/\/+$/, '') === '/image-generation/models' ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800']"><FolderOpenIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.ImageGenerationLab__models() }}</span></button>
      <button type="button" @click="navigation.openDiagnostics" data-testid="workspace-nav-diagnostics" :aria-current="route.path.replace(/\/+$/, '') === '/image-generation/diagnostics' ? 'page' : undefined" :title="lazyStrings.imageBenchmark__diagnostics()" :tw-class="['flex items-center gap-2 w-full rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', route.path.replace(/\/+$/, '') === '/image-generation/diagnostics' ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800']"><SlidersHorizontalIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.imageBenchmark__diagnostics() }}</span></button>
      <RouterLink to="/" :title="lazyStrings.imageGeneration__back_to_chats()" tw-class="flex items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"><ArrowLeftIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.imageGeneration__back_to_chats() }}</span></RouterLink>
      <button type="button" @click="router.push({ query: { ...route.query, settings: 'connection' } })" :title="lazyStrings.Sidebar__settings()" tw-class="flex items-center gap-2 w-full rounded-xl p-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"><SettingsIcon tw-class="w-4 h-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.Sidebar__settings() }}</span></button>
      <SidebarDebugControls :is-sidebar-open="isSidebarOpen" />
    </div>
  </nav>
</template>
