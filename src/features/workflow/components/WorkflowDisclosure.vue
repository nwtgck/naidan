<script setup lang="ts">
import { ref, useId } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
const props = defineProps<{ title: string | undefined, initiallyOpen?: boolean }>();
const open = ref(props.initiallyOpen ?? false);
const trigger = ref<HTMLButtonElement>();
const bodyId = useId();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="rounded-xl border border-gray-200/80 dark:border-gray-700/70 overflow-visible">
    <button ref="trigger" type="button" :aria-expanded="open" :aria-controls="bodyId" @click="open = !open" tw-class="w-full flex items-center gap-2 rounded-xl p-3 text-left text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
      <ChevronDownIcon :tw-class="['h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none', open ? '' : '-rotate-90']" />
      <span tw-class="min-w-0 flex-1">{{ title }}</span><slot name="summary" />
    </button>
    <SettingsCollapse :open="open" :return-focus="trigger"><div :id="bodyId" tw-class="px-3 pb-3 space-y-3"><slot /></div></SettingsCollapse>
  </section>
</template>
