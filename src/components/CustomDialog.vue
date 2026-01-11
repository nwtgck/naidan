<template>
  <div
    v-if="_props.show"
    data-testid="custom-dialog-overlay"
    class="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
    @keydown.esc="cancel"
    tabindex="0"
  >
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 data-testid="dialog-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">{{ _props.title }}</h3>
        <button @click="cancel" data-testid="dialog-close-x" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      <div data-testid="dialog-message" class="text-gray-700 dark:text-gray-300 mb-6">
        <slot>{{ _props.message }}</slot>
        <input
          v-if="_props.showInput"
          data-testid="dialog-input"
          :type="_props.inputType"
          :placeholder="_props.inputPlaceholder"
          :value="_props.inputValue"
          @input="$emit('update:inputValue', ($event.target as HTMLInputElement).value)"
          class="w-full mt-4 p-2 border border-gray-300 dark:border-gray-700 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div class="flex justify-end space-x-3">
        <button @click="cancel" data-testid="dialog-cancel-button" class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-200 dark:bg-gray-700 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600">
          {{ _props.cancelButtonText }}
        </button>
        <button
          @click="confirm"
          data-testid="dialog-confirm-button"
          class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
          :class="{
            'text-white bg-indigo-600 hover:bg-indigo-700': _props.confirmButtonVariant === 'default',
            'text-white bg-red-600 hover:bg-red-700': _props.confirmButtonVariant === 'danger',
          }"
        >
          {{ _props.confirmButtonText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">

const _props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: 'Dialog',
  },
  message: {
    type: String,
    default: '',
  },
  confirmButtonText: {
    type: String,
    default: 'Confirm',
  },
  cancelButtonText: {
    type: String,
    default: 'Cancel',
  },
  confirmButtonVariant: { // New prop for confirm button styling
    type: String,
    default: 'default', // 'default' | 'danger'
  },
  showInput: { // New prop for showing input
    type: Boolean,
    default: false,
  },
  inputValue: { // New prop for input value
    type: String,
    default: '',
  },
  inputType: { // New prop for input type
    type: String,
    default: 'text',
  },
  inputPlaceholder: { // New prop for input placeholder
    type: String,
    default: '',
  },
});

const emit = defineEmits(['confirm', 'cancel', 'update:inputValue']);

const confirm = () => {
  if (_props.showInput) {
    emit('confirm', _props.inputValue);
  } else {
    emit('confirm');
  }
};

const cancel = () => {
  emit('cancel');
};
</script>

<style scoped>
/* No specific scoped styles needed as Tailwind CSS is used */
</style>
