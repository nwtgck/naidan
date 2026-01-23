<script setup lang="ts">
import { ref } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useToast } from '../composables/useToast';
import type { ProviderProfile } from '../models/types';
import { 
  BookmarkPlus, Pencil, Trash, Check 
} from 'lucide-vue-next';
import { capitalize } from '../utils/string';

const props = defineProps<{
  profiles: ProviderProfile[];
}>();

const emit = defineEmits<{
  (e: 'update:profiles', value: ProviderProfile[]): void;
  (e: 'goToConnection'): void;
}>();

const { updateProviderProfiles } = useSettings();
const { addToast } = useToast();

// Profile Editing State
const editingProviderProfileId = ref<string | null>(null);
const editingProviderProfileName = ref('');

async function handleDeleteProviderProfile(id: string) {
  const index = props.profiles.findIndex(p => p.id === id);
  if (index === -1) return;
  
  const deletedProfile = props.profiles[index];
  if (!deletedProfile) return;

  const newProfiles = [...props.profiles];
  newProfiles.splice(index, 1);
  emit('update:profiles', newProfiles);
  await updateProviderProfiles(JSON.parse(JSON.stringify(newProfiles)));
  
  addToast({
    message: `Profile "${deletedProfile.name}" deleted`,
    actionLabel: 'Undo',
    onAction: async () => {
      const restoredProfiles = [...newProfiles];
      restoredProfiles.splice(index, 0, deletedProfile);
      emit('update:profiles', restoredProfiles);
      await updateProviderProfiles(JSON.parse(JSON.stringify(restoredProfiles)));
    },
    duration: 5000,
  });
}

function startRename(providerProfile: ProviderProfile) {
  editingProviderProfileId.value = providerProfile.id;
  editingProviderProfileName.value = providerProfile.name;
}

async function saveRename() {
  if (!editingProviderProfileId.value) return;
  const index = props.profiles.findIndex(p => p.id === editingProviderProfileId.value);
  if (index !== -1 && editingProviderProfileName.value.trim()) {
    const newProfiles = JSON.parse(JSON.stringify(props.profiles)) as ProviderProfile[];
    const profile = newProfiles[index];
    if (profile) {
      profile.name = editingProviderProfileName.value.trim();
      emit('update:profiles', newProfiles);
      await updateProviderProfiles(newProfiles);
    }
  }
  editingProviderProfileId.value = null;
}
</script>

<template>
  <div data-testid="profiles-section" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <BookmarkPlus class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Provider Profiles</h2>
      </div>
    
      <p class="text-sm font-medium text-gray-500">Save and switch between different AI provider configurations easily.</p>

      <div v-if="!profiles || profiles.length === 0" class="flex flex-col items-center justify-center p-16 bg-gray-50 dark:bg-gray-800/30 rounded-3xl border-2 border-dashed border-gray-200 dark:border-gray-800">
        <div class="p-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 mb-6">
          <BookmarkPlus class="w-12 h-12 text-gray-300" />
        </div>
        <p class="text-sm text-gray-400 font-bold mb-6">No profiles saved yet.</p>
        <button 
          @click="emit('goToConnection')"
          class="px-8 py-3 bg-blue-600 text-white text-sm font-bold rounded-2xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-95"
        >
          Go to Connection to Create One
        </button>
      </div>

      <div v-else class="grid grid-cols-1 gap-5">
        <div 
          v-for="providerProfile in profiles" 
          :key="providerProfile.id"
          class="group p-6 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-3xl flex items-center justify-between transition-all hover:border-blue-500/50 hover:shadow-xl hover:shadow-blue-500/5"
          data-testid="provider-profile-item"
        >
          <div class="flex-1 min-w-0 mr-6">
            <div v-if="editingProviderProfileId === providerProfile.id" class="flex items-center gap-2">
              <input 
                v-model="editingProviderProfileName"
                @keydown.enter="$event => !$event.isComposing && saveRename()"
                @keyup.esc="editingProviderProfileId = null"
                class="flex-1 bg-white dark:bg-gray-900 border-2 border-blue-500 rounded-xl px-4 py-2 text-sm font-bold text-gray-800 outline-none shadow-sm"
                autofocus
                data-testid="provider-profile-rename-input"
              />
              <button @click="saveRename" class="p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-xl transition-colors"><Check class="w-5 h-5" /></button>
            </div>
            <div v-else class="flex items-center gap-4">
              <h3 class="text-base font-bold text-gray-800 dark:text-white truncate">{{ providerProfile.name }}</h3>
              <span class="text-[10px] px-2.5 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg font-bold uppercase tracking-wider border border-blue-100 dark:border-blue-900/30" data-testid="provider-type-badge">{{ capitalize(providerProfile.endpointType) }}</span>
            </div>
            <div class="text-xs font-medium text-gray-400 mt-1.5 truncate">{{ providerProfile.endpointUrl }}</div>
            <div class="text-[11px] font-bold text-gray-500 mt-2 flex items-center gap-3">
              <span class="flex items-center gap-1.5 bg-gray-50 dark:bg-gray-800 px-2 py-0.5 rounded-lg border border-gray-100 dark:border-gray-700">{{ providerProfile.defaultModelId || 'No default model' }}</span>
              <span v-if="providerProfile.titleModelId" class="text-[9px] opacity-60 px-2 py-0.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-transparent">Title: {{ providerProfile.titleModelId }}</span>
            </div>
          </div>

          <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
            <button 
              @click="startRename(providerProfile)"
              class="p-2.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-xl transition-colors"
              title="Rename Profile"
              data-testid="provider-profile-rename-button"
            >
              <Pencil class="w-4 h-4" />
            </button>
            <button 
              @click="handleDeleteProviderProfile(providerProfile.id)"
              class="p-2.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-xl transition-colors"
              title="Delete Profile"
              data-testid="provider-profile-delete-button"
            >
              <Trash class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
