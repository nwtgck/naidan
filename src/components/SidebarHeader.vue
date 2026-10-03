<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { PanelLeftIcon } from 'lucide-vue-next';
import Logo from './Logo.vue';
import { lazyStrings } from '@/strings';
defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const appVersion = __APP_VERSION__;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div :tw-class="['pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 flex items-center overflow-hidden', expanded ? 'justify-between px-4' : 'justify-center px-1']" data-testid="sidebar-brand">
    <RouterLink v-if="expanded" to="/" tw-class="flex items-center gap-3 hover:opacity-80 transition-opacity cursor-pointer overflow-hidden">
      <div tw-class="p-1.5 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 shrink-0"><Logo :size="20" /></div>
      <div class="animate-in fade-in" tw-class="flex items-baseline gap-1.5 duration-300">
        <h1 tw-class="text-lg font-bold tracking-tight bg-gradient-to-br from-gray-800 to-gray-500 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">Naidan</h1>
        <div tw-class="flex items-center gap-1"><span tw-class="text-[10px] font-medium text-gray-400 dark:text-gray-500">v{{ appVersion }}</span><slot name="status" /></div>
      </div>
    </RouterLink>
    <button type="button" @click="emit('toggle')" :title="expanded ? lazyStrings.Sidebar__close_sidebar() : lazyStrings.Sidebar__open_sidebar()" :aria-label="expanded ? lazyStrings.Sidebar__close_sidebar() : lazyStrings.Sidebar__open_sidebar()" data-testid="sidebar-toggle" tw-class="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><PanelLeftIcon tw-class="w-5 h-5" /></button>
  </div>
</template>
