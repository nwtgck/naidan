<script setup lang="ts">
import { useConfirm } from '@/composables/useConfirm';
import { usePrompt } from '@/composables/usePrompt';
import CustomDialog from '@/components/CustomDialog.vue';

const {
  isConfirmOpen,
  confirmTitle,
  confirmMessage,
  confirmConfirmButtonText,
  confirmCancelButtonText,
  confirmButtonVariant,
  confirmIcon,
  handleConfirm,
  handleCancel,
} = useConfirm();

const {
  isPromptOpen,
  promptTitle,
  promptMessage,
  promptConfirmButtonText,
  promptCancelButtonText,
  promptInputValue,
  promptBodyComponent,
  handlePromptConfirm,
  handlePromptCancel,
} = usePrompt();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {})
});
</script>

<template>
  <CustomDialog
    :show="isConfirmOpen"
    :title="confirmTitle"
    :icon="confirmIcon"
    :message="confirmMessage"
    :confirm-button-text="confirmConfirmButtonText"
    :cancel-button-text="confirmCancelButtonText"
    :confirm-button-variant="confirmButtonVariant"
    @confirm="handleConfirm"
    @cancel="handleCancel"
  />

  <CustomDialog
    :show="isPromptOpen"
    :title="promptTitle"
    :message="promptMessage"
    :confirm-button-text="promptConfirmButtonText"
    :cancel-button-text="promptCancelButtonText"
    confirm-button-variant="default"
    :show-input="true"
    :input-value="promptInputValue"
    :body-component="promptBodyComponent"
    @update:input-value="promptInputValue = $event"
    @confirm="handlePromptConfirm"
    @cancel="handlePromptCancel"
  />
</template>
