<script setup lang="ts">
import { useRouter } from 'vue-router';
import { onMounted } from 'vue';
const router = useRouter();
onMounted(() => {
  router.replace('/settings/connection');
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>
<template>
  <div />
</template>
