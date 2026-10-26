<script setup lang="ts">
import { EyeIcon, PencilIcon } from 'lucide-vue-next';

type AccessMode = 'read-only' | 'read-write';
const props = defineProps<{
  modelValue: AccessMode,
  disabled: boolean,
  label: string | undefined,
  readOnlyLabel: string | undefined,
  readWriteLabel: string | undefined,
  testIdPrefix: string | undefined,
}>();
const emit = defineEmits<{ (event: 'update:modelValue', value: AccessMode): void }>();
const modes = ['read-only', 'read-write'] as const;

function choose({ mode }: { mode: AccessMode }) {
  if (!props.disabled) {
    emit('update:modelValue', mode);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div role="group" :aria-label="label" tw-class="inline-flex max-w-full overflow-x-auto rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800 inset-ring-1 inset-ring-gray-200/50 dark:inset-ring-gray-700/50">
    <button
      v-for="mode in modes"
      :key="mode"
      type="button"
      :aria-pressed="modelValue === mode"
      :data-testid="testIdPrefix === undefined ? undefined : `${testIdPrefix}-${mode}`"
      :disabled="disabled"
      :tw-class="['inline-flex min-h-9 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/35', modelValue === mode ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 inset-ring-1 inset-ring-gray-200 dark:inset-ring-gray-600' : 'text-gray-500 dark:text-gray-400 enabled:hover:bg-gray-100 dark:enabled:hover:bg-gray-700/40 enabled:hover:text-gray-700 dark:enabled:hover:text-gray-200']"
      @click="choose({ mode })"
    >
      <EyeIcon v-if="mode === 'read-only'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
      <PencilIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
      {{ mode === 'read-only' ? readOnlyLabel : readWriteLabel }}
    </button>
  </div>
</template>
