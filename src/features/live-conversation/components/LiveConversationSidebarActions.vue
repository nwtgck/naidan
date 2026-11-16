<script setup lang="ts">
import { SquarePenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LiveConversationNavigation } from '@/features/live-conversation/navigation';

defineProps<{ navigation: LiveConversationNavigation, expanded: boolean }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <button type="button" :disabled="!navigation.canReset.value" @click="navigation.newConversation" :title="lazyStrings.liveConversation__new_conversation()" :aria-label="lazyStrings.liveConversation__new_conversation()" :tw-class="['flex min-h-9 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-gray-50/70 font-medium text-gray-700 transition-colors hover:border-blue-200 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-200 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10', expanded ? 'w-full px-3 py-2.5 text-xs' : 'h-9 w-9']" data-testid="live-sidebar-new"><SquarePenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span v-if="expanded" tw-class="truncate">{{ lazyStrings.liveConversation__new_conversation() }}</span></button>
</template>
