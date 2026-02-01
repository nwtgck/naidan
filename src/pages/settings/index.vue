<script setup lang="ts">
import { useRouter } from 'vue-router';
import { onMounted } from 'vue';
const router = useRouter();
onMounted(() => {
  router.replace('/settings/connection');
});
</script>
<template>
  <div />
</template>
