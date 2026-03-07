<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next';

withDefaults(defineProps<{
  isNested?: boolean;
  noPadding?: boolean;
}>(), {
  isNested: false,
  noPadding: false
});
</script>

<template>
  <div 
    class="flex items-center gap-2 text-gray-400" 
    :class="[
      noPadding ? '' : 'py-2',
      (isNested && !noPadding) ? 'px-5' : ''
    ]" 
    data-testid="assistant-waiting-indicator"
  >
    <Loader2 class="w-4 h-4 animate-spin" />
    <span class="text-xs font-medium">Waiting for response...</span>
  </div>
</template>
