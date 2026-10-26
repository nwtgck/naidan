<script setup lang="ts">
import { type Component, onErrorCaptured, onScopeDispose, shallowRef, watch } from 'vue';
import { useImportExportModal } from '@/features/import-export/composables/useImportExportModal';

const { request, close, completeLoad } = useImportExportModal();
const modal = shallowRef<Component | undefined>(undefined);
let disposed = false;

onErrorCaptured(() => {
  const current = request.value;
  if (current !== undefined) {
    completeLoad({ requestId: current.id, status: 'failed' });
  }
  modal.value = undefined;
  // This optional entry point must also contain failures after a chunk loads.
  return false;
});

watch(() => request.value?.id, async requestId => {
  if (requestId === undefined) {
    return;
  }
  try {
    // The app-level host survives dismissal of an originating hint popover.
    // Load the real export UI only after its explicit open action.
    const component = modal.value ?? (await import('@/features/import-export/components/ImportExportModal.vue')).default;
    if (!disposed && request.value?.id === requestId) {
      modal.value = component;
      completeLoad({ requestId, status: 'ready' });
    }
  } catch {
    if (!disposed) {
      completeLoad({ requestId, status: 'failed' });
    }
  }
}, { immediate: true });

onScopeDispose(() => {
  disposed = true;
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <component
    :is="modal"
    v-if="modal !== undefined && request?.status === 'ready'"
    :key="request.id"
    :is-open="true"
    :initial-mode="request.initialMode"
    @close="close({ requestId: request.id })"
  />
</template>
