<template>
  <div
    v-if="_props.show"
    data-testid="custom-dialog-overlay"
    class="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px] transition-all"
    @keydown.esc="cancel"
    tabindex="0"
  >
    <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden border border-gray-100 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200">
      <!-- Header -->
      <div class="px-6 py-4 flex justify-between items-center bg-gray-50/50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
        <h3 data-testid="dialog-title" class="text-base font-bold text-gray-800 dark:text-white tracking-tight">{{ _props.title }}</h3>
        <button @click="cancel" data-testid="dialog-close-x" class="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-white dark:hover:bg-gray-700 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="p-6">
        <div data-testid="dialog-message" class="text-sm font-medium text-gray-600 dark:text-gray-400 leading-relaxed">
          <slot>{{ _props.message }}</slot>
          <input
            v-if="_props.showInput"
            data-testid="dialog-input"
            :type="_props.inputType"
            :placeholder="_props.inputPlaceholder"
            :value="_props.inputValue"
            @input="$emit('update:inputValue', ($event.target as HTMLInputElement).value)"
            @keydown.enter="$event => !$event.isComposing && confirm()"
            class="w-full mt-4 px-4 py-3 border border-gray-100 dark:border-gray-700 rounded-xl bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-sm"
          />
        </div>

        <!-- Actions -->
        <div class="flex justify-end gap-3 mt-8">
          <button @click="cancel" data-testid="dialog-cancel-button" class="px-5 py-2.5 text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
            {{ _props.cancelButtonText }}
          </button>
          <button
            @click="confirm"
            data-testid="dialog-confirm-button"
            class="px-6 py-2.5 text-xs font-bold rounded-xl transition-all shadow-lg active:scale-95"
            :class="{
              'text-white bg-blue-600 hover:bg-blue-700 shadow-blue-500/30': _props.confirmButtonVariant === 'default',
              'text-white bg-red-600 hover:bg-red-700 shadow-red-500/30': _props.confirmButtonVariant === 'danger',
            }"
          >
            {{ _props.confirmButtonText }}
          </button>
        </div>
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
    required: true, // Make it required
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
