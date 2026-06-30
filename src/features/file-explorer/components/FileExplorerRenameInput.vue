<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { onClickOutside } from '@vueuse/core';

const props = defineProps<{
  currentName: string,
}>();

const emit = defineEmits<{
  (e: 'confirm', value: string): void,
  (e: 'cancel'): void,
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const value = ref(props.currentName);

onMounted(() => {
  if (inputRef.value) {
    inputRef.value.focus();
    // Select filename without extension
    const dot = props.currentName.lastIndexOf('.');
    const end = dot > 0 ? dot : props.currentName.length;
    inputRef.value.setSelectionRange(0, end);
  }
});

onClickOutside(inputRef, () => {
  emit('confirm', value.value);
});

function onKeyDown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    emit('confirm', value.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('cancel');
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <input
    ref="inputRef"
    v-model="value"
    type="text"
    data-testid="rename-input"
    class="w-full px-1.5 py-0.5 text-xs rounded border border-blue-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/30"
    @keydown="onKeyDown({ event: $event })"
    @click.stop
  />
</template>
