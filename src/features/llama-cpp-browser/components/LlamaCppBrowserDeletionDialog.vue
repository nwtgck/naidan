<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CustomDialog from '@/components/CustomDialog.vue';
import { lazyStrings } from '@/strings';
import type { ModelRemovalRequest } from '@/features/llama-cpp-browser/runtime/model-store';
import type { DeletionPlan } from '@/features/llama-cpp-browser/runtime/deletion-plan';
const props = defineProps<{ request: ModelRemovalRequest | undefined }>();
const emit = defineEmits<{ confirm: [plan: DeletionPlan], cancel: [] }>();
const shared = ref(true);
watch(() => props.request, () => {
  shared.value = true;
});
const selected = computed(() => shared.value ? props.request?.sharedPlan ?? props.request?.plan : props.request?.plan);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <CustomDialog :show="request !== undefined" confirm-button-variant="danger" @confirm="selected && emit('confirm', selected)" @cancel="emit('cancel')">
    <p>{{ lazyStrings.llamaCppBrowser__delete_model_confirmation() }}</p>
    <div v-if="request?.sharedPlan" tw-class="mt-4 space-y-2">
      <label tw-class="flex items-start gap-2 text-sm"><input v-model="shared" type="checkbox" data-testid="llama-delete-shared" tw-class="mt-1 accent-purple-600" /><span>{{ lazyStrings.LlamaCppBrowserDeletionDialog__also_delete_shared_multimodal_files() }}</span></label>
      <p v-if="request.affectedVariants > 0" tw-class="text-xs text-amber-700 dark:text-amber-400" data-testid="llama-delete-shared-warning">{{ lazyStrings.LlamaCppBrowserDeletionDialog__other_variants_will_lose_multimodal_support() }}</p>
    </div>
    <details tw-class="mt-4 text-xs text-gray-500 dark:text-gray-400" data-testid="llama-delete-details">
      <summary tw-class="cursor-pointer font-medium">{{ lazyStrings.llamaCppBrowser__files_to_delete() }}</summary>
      <ul tw-class="mt-2 max-h-48 overflow-y-auto space-y-1 font-mono break-all"><li v-for="file in selected?.files" :key="file.path">{{ file.path }}</li></ul>
    </details>
  </CustomDialog>
</template>
