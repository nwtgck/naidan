<template>
  <Transition name="modal">
    <div
      v-if="_props.show"
      data-testid="custom-dialog-overlay"
      class="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px]"
      @keydown.esc="cancel"
      tabindex="0"
    >
      <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden border border-gray-100 dark:border-gray-800 modal-content-zoom">
        <!-- Header -->
        <div class="px-6 py-4 flex justify-between items-center bg-gray-50/50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-2 overflow-hidden">
            <component v-if="_props.icon" :is="_props.icon" class="w-4 h-4 text-blue-500 shrink-0" />
            <h3 data-testid="dialog-title" class="text-base font-bold text-gray-800 dark:text-white tracking-tight truncate">{{ _props.title }}</h3>
          </div>
          <button @click="cancel" data-testid="dialog-close-x" class="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-white dark:hover:bg-gray-700 transition-colors shrink-0">
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

            <div v-if="_props.bodyComponent" class="mt-4">
              <component :is="_props.bodyComponent" />
            </div>
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
  </Transition>
</template>

<script setup lang="ts">
import type { Component } from 'vue';

const _props = withDefaults(defineProps<{
  show?: boolean;
  title?: string;
  icon?: Component | null;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  confirmButtonVariant: 'default' | 'danger';
  showInput?: boolean;
  inputValue?: string;
  inputType?: string;
  inputPlaceholder?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyComponent?: Component | any | null;
}>(), {
  show: false,
  title: 'Dialog',
  icon: null,
  message: '',
  confirmButtonText: 'Confirm',
  cancelButtonText: 'Cancel',
  showInput: false,
  inputValue: '',
  inputType: 'text',
  inputPlaceholder: '',
  bodyComponent: null,
});

const emit = defineEmits<{
  (e: 'confirm', value?: string): void;
  (e: 'cancel'): void;
  (e: 'update:inputValue', value: string): void;
}>();

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
/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.9);
  opacity: 0;
}
</style>
