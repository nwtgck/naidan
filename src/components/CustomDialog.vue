<template>
  <Transition name="modal">
    <div
      v-if="_props.show"
      data-testid="custom-dialog-overlay"
      tw-class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px] focus:outline-none"
      @keydown.esc="cancel"
      @click="setActiveFocusArea({ area: 'dialog' })"
      @focusin="setActiveFocusArea({ area: 'dialog' })"
      tabindex="-1"
    >
      <div class="modal-content-zoom" tw-class="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-2xl shadow-gray-950/10 dark:border-gray-700/80 dark:bg-gray-900 dark:shadow-black/35">
        <!-- Header -->
        <div tw-class="flex items-center justify-between gap-4 border-b border-gray-200/60 bg-gray-50/70 px-5 py-4 dark:border-gray-700/50 dark:bg-gray-800/30 sm:px-6">
          <div tw-class="flex min-w-0 items-center gap-3">
            <span v-if="_props.icon" :tw-class="['flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', _props.confirmButtonVariant === 'danger' ? 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400' : 'bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400']"><component :is="_props.icon" aria-hidden="true" tw-class="h-4 w-4" /></span>
            <h3 data-testid="dialog-title" tw-class="min-w-0 break-words text-base font-semibold leading-6 tracking-tight text-gray-900 dark:text-gray-100">{{ _props.title || lazyStrings.CustomDialog__dialog() }}</h3>
          </div>
          <button type="button" @click="cancel" :aria-label="lazyStrings.SHARED__cancel()" data-testid="dialog-close-x" tw-class="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800 dark:hover:text-gray-200">
            <svg tw-class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div tw-class="px-5 pt-5 sm:px-6">
          <div data-testid="dialog-message" tw-class="break-words text-sm leading-7 text-gray-600 dark:text-gray-300">
            <slot>{{ _props.message }}</slot>

            <input
              v-if="_props.showInput"
              data-testid="dialog-input"
              :type="_props.inputType"
              :placeholder="_props.inputPlaceholder"
              :value="_props.inputValue"
              @input="$emit('update:inputValue', ($event.target as HTMLInputElement).value)"
              @keydown.enter="$event => !$event.isComposing && confirm()"
              tw-class="mt-4 min-h-11 w-full rounded-xl border border-gray-200 bg-gray-50/60 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:bg-gray-900"
            />

            <div v-if="_props.bodyComponent" tw-class="mt-4">
              <component :is="_props.bodyComponent" />
            </div>
          </div>

          <details v-if="_props.details" data-testid="dialog-details" tw-class="mt-4 rounded-xl border border-gray-200/70 bg-gray-50/60 p-3 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-800/30 dark:text-gray-400">
            <summary tw-class="cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30">{{ _props.details.summary }}</summary>
            <ul tw-class="mt-2 max-h-48 overflow-y-auto space-y-1 font-mono break-all" data-testid="dialog-details-items">
              <li v-for="item in _props.details.items" :key="item">{{ item }}</li>
            </ul>
          </details>

          <!-- Actions -->
          <div tw-class="-mx-5 mt-5 flex flex-wrap justify-end gap-2 border-t border-gray-200/60 bg-gray-50/60 px-5 py-4 dark:border-gray-700/50 dark:bg-gray-800/25 sm:-mx-6 sm:px-6">
            <button type="button" @click="cancel" data-testid="dialog-cancel-button" tw-class="min-h-10 rounded-xl border border-transparent px-4 py-2 text-[13px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100">
              {{ _props.cancelButtonText || lazyStrings.SHARED__cancel() }}
            </button>
            <button
              @click="confirm"
              type="button"
              data-testid="dialog-confirm-button"
              :tw-class="['min-h-10 rounded-xl border px-4 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900', {
                'border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 focus-visible:ring-blue-400/40 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-800': _props.confirmButtonVariant === 'default',
                'border-red-200/90 bg-red-50/70 text-red-600 hover:border-red-300 hover:bg-red-100/70 focus-visible:ring-red-400/40 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400 dark:hover:border-red-500/45 dark:hover:bg-red-500/15': _props.confirmButtonVariant === 'danger',
              }]"
            >
              {{ _props.confirmButtonText || lazyStrings.SHARED__confirm() }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { lazyStrings } from '@/strings';
import type { Component } from 'vue';
import { useLayout } from '@/composables/useLayout';

const { setActiveFocusArea } = useLayout();

const _props = withDefaults(defineProps<{
  details?: { summary: string, items: string[] },
  show?: boolean,
  title?: string,
  icon?: Component | null,
  message?: string,
  confirmButtonText?: string,
  cancelButtonText?: string,
  confirmButtonVariant: 'default' | 'danger',
  showInput?: boolean,
  inputValue?: string,
  inputType?: string,
  inputPlaceholder?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyComponent?: Component | any | null,
}>(), {
  show: false,
  title: '',
  icon: null,
  message: '',
  confirmButtonText: '',
  cancelButtonText: '',
  showInput: false,
  inputValue: '',
  inputType: 'text',
  inputPlaceholder: '',
  bodyComponent: null,
});

const emit = defineEmits<{
  (e: 'confirm', value?: string): void,
  (e: 'cancel'): void,
  (e: 'update:inputValue', value: string): void,
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


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<style scoped>
/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 180ms ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: opacity 180ms ease, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: translateY(6px) scale(0.985);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .modal-enter-active,
  .modal-leave-active,
  .modal-enter-active .modal-content-zoom,
  .modal-leave-active .modal-content-zoom {
    transition: none;
  }
}
</style>
