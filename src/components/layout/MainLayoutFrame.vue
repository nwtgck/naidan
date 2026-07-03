<script setup lang="ts">
import { computed } from 'vue';
import { tw, twClasses } from 'virtual:naidan-tailwind';

const props = defineProps<{
  sidebarWidth:
    | 'collapsed'
    | 'expanded',
}>();

const sidebarWidthClass = computed(() => {
  switch (props.sidebarWidth) {
  case 'collapsed':
    return tw('w-10');
  case 'expanded':
    return tw('w-64');
  default: {
    const _ex: never = props.sidebarWidth;
    return _ex;
  }
  }
});


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
  <div tw-class="flex h-dvh bg-gray-50/50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden transition-colors duration-300">
    <div
      :tw-class="['border-r border-gray-100 dark:border-gray-800 shrink-0 h-full transition-all duration-300 ease-in-out relative z-30', twClasses(sidebarWidthClass)]"
    >
      <slot name="sidebar" />
    </div>

    <main tw-class="flex-1 relative flex flex-col min-w-0 bg-transparent z-30">
      <slot name="main" />
    </main>
  </div>
</template>
