<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { WorkflowImageParameters, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import { workflowImageParameterLabel, workflowImageParameterChoices } from '@/features/workflow/logic/image-forms';
import { workflowImageParameterType } from '@/features/workflow/logic/image-input';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
const props = defineProps<{ field: keyof WorkflowImageParameters, value: WorkflowValue, steps: WorkflowStep[], disabled: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowValue] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const valueMode = ref(false);
const options = computed(() => workflowImageParameterChoices({ key: props.field }).map(value => ({ value, label: value })));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2" :data-image-parameter="field">
    <div tw-class="flex items-center justify-between gap-2"><h4 tw-class="text-xs font-medium">{{ workflowImageParameterLabel({ key: field }) }}</h4><button v-if="options.length && value.type === 'literal'" type="button" :disabled="locked" @click="valueMode = !valueMode" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ valueMode ? lazyStrings.workflow__fixed_value() : lazyStrings.workflow__choose_value() }}</button></div>
    <SettingsFormSelect v-if="options.length && !valueMode && value.type === 'literal'" :model-value="String(value.value)" :options="options" :disabled="locked" :label="workflowImageParameterLabel({ key: field })" @update:model-value="emit('change', { type: 'literal', value: $event })" />
    <WorkflowValueEditor v-else :value="value" :steps="steps" :disabled="disabled" :expected="workflowImageParameterType({ key: field })" @change="emit('change', $event)" />
  </div>
</template>
