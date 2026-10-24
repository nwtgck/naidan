<script setup lang="ts">
import { computed, inject, provide, type Ref } from 'vue';

// Keep portaled settings menus inside the visibility of their owning region.
// The slot stays mounted: hiding a panel must not discard its draft or work.
const props = defineProps<{ active: boolean, returnFocus: HTMLElement | undefined }>();
const parentOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const parentFocus = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
provide('settings-disclosure-open', computed(() => props.active && parentOpen?.value !== false));
provide('settings-disclosure-focus-return', () => parentOpen?.value === false ? parentFocus?.() : props.returnFocus);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template><slot /></template>
