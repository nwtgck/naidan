<script setup lang="ts">
import WorkflowView from '@/features/workflow/WorkflowView.vue';
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><WorkflowView /></template>
