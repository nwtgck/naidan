<script setup lang="ts">
import { FolderIcon as VolumeIcon } from 'lucide-vue-next';

const props = defineProps<{
  name: string | undefined,
  path: string | undefined,
  sourceLabel: string | undefined,
  activation: 'open' | 'none',
  primaryTestId: string | undefined,
}>();
const emit = defineEmits<{ (event: 'open'): void }>();

function activate() {
  switch (props.activation) {
  case 'open': emit('open');
    return;
  case 'none': return;
  default: {
    const _ex: never = props.activation;
    throw new Error(`Unhandled volume activation: ${_ex}`);
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="@container min-w-0 rounded-xl border border-gray-200/60 bg-gray-50/50 dark:border-gray-700/40 dark:bg-gray-800/35">
    <div class="volume-list-item-layout" :class="{ 'volume-list-item-with-permissions': !!$slots.permissions }" tw-class="px-3 py-2">
      <component
        :is="activation === 'open' ? 'button' : 'div'"
        :type="activation === 'open' ? 'button' : undefined"
        class="volume-list-item-primary"
        :data-testid="primaryTestId"
        :title="path"
        tw-class="flex min-w-0 items-start gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        @click="activate"
      >
        <VolumeIcon aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
        <span tw-class="block min-w-0 flex-1">
          <span tw-class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <slot name="name"><span tw-class="min-w-0 break-words text-sm font-medium text-gray-800 dark:text-gray-300">{{ name }}</span></slot>
            <slot name="name-actions" />
            <span v-if="sourceLabel" tw-class="shrink-0 text-xs text-gray-500 dark:text-gray-400">{{ sourceLabel }}</span>
          </span>
          <span v-if="path" tw-class="mt-0.5 block break-all text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ path }}</span>
          <slot name="metadata" />
        </span>
      </component>
      <div v-if="$slots.permissions" class="volume-list-item-permissions" tw-class="min-w-0 max-w-full"><slot name="permissions" /></div>
      <div class="volume-list-item-actions" tw-class="flex items-center gap-1"><slot name="actions" /></div>
    </div>
    <slot name="editor" />
  </div>
</template>

<style scoped>
.volume-list-item-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 0.75rem;
  row-gap: 0.5rem;
}
.volume-list-item-primary {
  grid-column: 1;
  grid-row: 1;
}
.volume-list-item-permissions {
  grid-column: 1 / -1;
  grid-row: 2;
  justify-self: start;
}
.volume-list-item-actions {
  grid-column: 2;
  grid-row: 1;
}
@container (max-width: 26rem) {
  .volume-list-item-layout:not(.volume-list-item-with-permissions) > .volume-list-item-primary {
    grid-column: 1 / -1;
  }
  .volume-list-item-layout:not(.volume-list-item-with-permissions) > .volume-list-item-actions {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-self: end;
  }
}
@container (min-width: 38rem) {
  .volume-list-item-with-permissions {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .volume-list-item-with-permissions > .volume-list-item-permissions {
    grid-column: 2;
    grid-row: 1;
  }
  .volume-list-item-with-permissions > .volume-list-item-actions {
    grid-column: 3;
  }
}
</style>
