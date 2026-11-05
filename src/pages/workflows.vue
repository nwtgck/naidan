<script setup lang="ts">
import WorkflowWorkspace from '@/features/workflow/WorkflowWorkspace.vue';
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><WorkflowWorkspace /></template>
