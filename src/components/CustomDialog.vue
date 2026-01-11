<template>
  <div v-if="_props.show" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">{{ _props.title }}</h3>
        <button @click="cancel" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      <div class="text-gray-700 dark:text-gray-300 mb-6">
        <slot>{{ _props.message }}</slot>
      </div>
      <div class="flex justify-end space-x-3">
        <button @click="cancel" class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-200 dark:bg-gray-700 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600">
          {{ _props.cancelButtonText }}
        </button>
        <button @click="confirm" class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700">
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
});

const emit = defineEmits(['confirm', 'cancel']);

const confirm = () => {
  emit('confirm');
};

const cancel = () => {
  emit('cancel');
};
</script>

<style scoped>
/* No specific scoped styles needed as Tailwind CSS is used */
</style>
