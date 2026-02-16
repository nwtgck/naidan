<script setup lang="ts">
import { computed, ref, type CSSProperties } from 'vue';
import { useElementBounding, useWindowSize, onClickOutside } from '@vueuse/core';

const props = withDefaults(defineProps<{
  isOpen: boolean;
  triggerEl: HTMLElement | null;
  width?: number;
}>(), {
  width: 192 // Standard w-48 to ensure text like "Compare Versions" doesn't wrap
});

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const dropdownRef = ref<HTMLElement | null>(null);
const { width: windowWidth, height: windowHeight } = useWindowSize();
const triggerBounding = useElementBounding(() => props.triggerEl);

const isOpeningUp = computed(() => {
  if (!props.triggerEl) return false;
  const spaceAbove = triggerBounding.top.value;
  const spaceBelow = windowHeight.value - triggerBounding.bottom.value;
  return spaceAbove > spaceBelow && spaceAbove > 150;
});

const floatingStyle = computed((): CSSProperties => {
  if (!props.isOpen || !props.triggerEl) return {};

  const rect = triggerBounding;
  const margin = 4;
  const menuWidth = props.width || 192;

  // Horizontal alignment: Align with the right edge, but adjust if it goes off-screen
  let left = rect.right.value - menuWidth;
  if (left < 8) left = 8;
  if (left + menuWidth > windowWidth.value - 8) {
    left = windowWidth.value - menuWidth - 8;
  }

  // Vertical alignment: Open upwards if there's enough space, otherwise open downwards
  const openUp = isOpeningUp.value;

  return {
    position: 'fixed',
    left: `${left}px`,
    width: `${menuWidth}px`,
    zIndex: 9999,
    ...(openUp
      ? { bottom: `${windowHeight.value - rect.top.value + margin}px` }
      : { top: `${rect.bottom.value + margin}px` }
    )
  };
});

onClickOutside(dropdownRef, (event) => {
  if (props.triggerEl?.contains(event.target as Node)) return;
  emit('close');
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dropdown">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        class="bg-white/95 dark:bg-gray-800/95 backdrop-blur-md border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl py-1 overflow-hidden"
        :class="isOpeningUp ? 'origin-bottom-right' : 'origin-top-right'"
        :style="floatingStyle"
      >
        <slot></slot>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: v-bind(isOpeningUp ? "'scale(0.95) translateY(10px)'" : "'scale(0.95) translateY(-10px)'");
}
</style>
