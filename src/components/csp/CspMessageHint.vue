<script setup lang="ts">
import { markRaw, onErrorCaptured, onMounted, onScopeDispose, shallowRef, type Component } from 'vue';
import type { CspHintTarget } from '@/logic/csp-message-hints/types';
import type { CspHintActivityForDisplayOnly } from './types';

defineOptions({ inheritAttrs: false });
/**
 * Place warnings and hints where people using Naidan are focused
 * at that point in their task.
 *
 * While editing a setting, show the warning beside the relevant field.
 * After an action fails, show the hint directly below its error message.
 *
 * Keep advance warnings compact. Expanded guidance may use more space.
 * activityForDisplayOnly selects copy, never an endpoint or an action.
 */
defineProps<{ target: CspHintTarget | undefined, presentation: 'compact' | 'error' | 'error-details', activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined }>();

const content = shallowRef<Component>();
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
onErrorCaptured(() => {
  content.value = undefined;
  return false;
});
onMounted(() => {
  // Diagnostics are optional. Their module must never become a prerequisite
  // for mounting the existing controls or displaying the original error.
  void import('./CspMessageHintContent.vue').then(module => {
    if (!disposed) {
      content.value = markRaw(module.default);
    }
  }).catch(() => { /* Keep the original UI when diagnostic loading fails. */ });
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <component :is="content" v-if="content !== undefined" v-bind="$attrs" :target="target" :presentation="presentation" :activity-for-display-only="activityForDisplayOnly" />
</template>
