<script setup lang="ts" generic="T extends string | number">
import { computed } from 'vue';
import SettingsSelect from './SettingsSelect.vue';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  modelValue: T,
  options: readonly { value: T, label: string | undefined, disabled?: boolean }[],
  label: string | undefined,
  disabled: boolean,
  presentation?: 'field' | 'inline',
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();
const choices = computed(() => props.options.map(option => ({ ...option, value: String(option.value) })));

function choose({ value }: { value: string }): void {
  const option = props.options.find(option => String(option.value) === value && !option.disabled);
  if (option && !props.disabled) {
    emit('update:modelValue', option.value);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <SettingsSelect v-bind="$attrs" :model-value="String(modelValue)" :options="choices" :label="label" :disabled="disabled" :presentation="presentation === 'inline' ? 'inline' : 'toolbar'" size="compact" :menu-width-rem="22" class="settings-form-select" :class="{ 'settings-form-select-field': presentation !== 'inline' }" tw-class="disabled:cursor-not-allowed disabled:opacity-45" @update:model-value="choose({ value: $event })" />
</template>
<style>
.settings-form-select-field.settings-select-trigger.settings-select-trigger-compact {
  min-height: 2.375rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  border-color: rgb(229 231 235 / 0.8);
  background: rgb(249 250 251 / 0.6);
}

.settings-form-select-field.settings-select-trigger:hover:not(:disabled) {
  border-color: rgb(147 197 253 / 0.65);
  background: rgb(239 246 255 / 0.35);
}

.dark .settings-form-select-field.settings-select-trigger {
  border-color: rgb(55 65 81 / 0.7);
  background: rgb(31 41 55 / 0.4);
}

.dark .settings-form-select-field.settings-select-trigger:hover:not(:disabled) {
  border-color: rgb(59 130 246 / 0.35);
  background: rgb(31 41 55 / 0.7);
}
</style>
