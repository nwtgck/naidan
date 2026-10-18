<script setup lang="ts">
import { ref, useId } from 'vue';
import SettingsCollapse from './SettingsCollapse.vue';
import { ChevronDownIcon } from 'lucide-vue-next';
const props = defineProps<{ title: string | undefined, summary?: string, testId?: string }>();
const emit = defineEmits<{ (e: 'update:open', open: boolean): void }>();
const open = ref(false);

const trigger = ref<HTMLButtonElement | null>(null);
const id = useId();

function toggle() {
  open.value = !open.value;
  emit('update:open', open.value);
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="border-t border-gray-200/70 dark:border-gray-800">
    <button ref="trigger" type="button" :data-testid="props.testId" :aria-expanded="open" :aria-controls="id" tw-class="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30" @click="toggle">
      <span v-if="$slots.icon" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400"><slot name="icon" /></span><span tw-class="min-w-0 flex-1 text-sm font-medium text-gray-700 dark:text-gray-200">{{ title }}</span><span tw-class="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400"><slot name="summary">{{ summary }}</slot></span><ChevronDownIcon :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200', open && 'rotate-180']" />
    </button>
    <SettingsCollapse :id="id" :open="open" :return-focus="trigger ?? undefined"><div tw-class="pb-5 pt-1"><slot /></div></SettingsCollapse>
  </section>
</template>
