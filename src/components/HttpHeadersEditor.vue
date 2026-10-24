<script setup lang="ts">
import SettingsDisclosure from './SettingsDisclosure.vue';
import { PlusIcon, Trash2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
const props = defineProps<{ modelValue: readonly [string, string][], testIdPrefix: string, namePlaceholder?: string, title?: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', headers: [string, string][]): void, (e: 'save'): void }>();

function update({ index, field, value }: { index: number, field: 0 | 1, value: string }) {
  emit('update:modelValue', props.modelValue.map((header, i) => i === index ? [field === 0 ? value : header[0], field === 1 ? value : header[1]] : [...header]));
}

function add() {
  emit('update:modelValue', [...props.modelValue.map(header => [...header] as [string, string]), ['', '']]);
}

function remove({ index }: { index: number }) {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index).map(header => [...header]));
  emit('save');
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <SettingsDisclosure :title="title ?? lazyStrings.HttpHeadersEditor__http_headers()" :summary="String(modelValue.length)">
    <div tw-class="space-y-2 pb-3">
      <div v-for="(header, index) in modelValue" :key="index" tw-class="flex items-start gap-2">
        <div tw-class="grid min-w-0 flex-1 grid-cols-2 gap-2">
          <input :value="header[0]" :aria-label="lazyStrings.HttpHeadersEditor__name()" :placeholder="namePlaceholder ?? lazyStrings.HttpHeadersEditor__name()" :data-testid="`${testIdPrefix}-name-input`" tw-class="min-h-10 min-w-0 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" @input="update({ index, field: 0, value: ($event.target as HTMLInputElement).value })" @blur="emit('save')" />
          <input :value="header[1]" :aria-label="lazyStrings.HttpHeadersEditor__value()" :placeholder="lazyStrings.HttpHeadersEditor__value()" :data-testid="`${testIdPrefix}-value-input`" tw-class="min-h-10 min-w-0 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" @input="update({ index, field: 1, value: ($event.target as HTMLInputElement).value })" @blur="emit('save')" />
        </div>
        <button type="button" :aria-label="lazyStrings.HttpHeadersEditor__remove_header()" :data-testid="`${testIdPrefix}-remove-button`" tw-class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-gray-400 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30" @click="remove({ index })"><Trash2Icon tw-class="h-4 w-4" /></button>
      </div>
      <button type="button" :data-testid="`${testIdPrefix}-add-button`" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-md text-xs text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-blue-400" @click="add"><PlusIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.HttpHeadersEditor__add_header() }}</button>
    </div>
  </SettingsDisclosure>
</template>
