<script setup lang="ts">
import BranchingMethod from './BranchingMethod.vue';
import UiText from '../../site/UiText.vue';
import type { BranchingCopy, ReplicaChromeCopy } from '../../site/messages';

defineProps<{ copy: BranchingCopy; chrome: ReplicaChromeCopy }>();

const methods = ['edit', 'resend', 'regenerate', 'fork'] as const;

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here.
    },
  }) || {}),
});
</script>

<template>
  <div class="branch-sections" data-testid="branch-demo">
    <p class="branch-note"><UiText :text="copy.note" /></p>
    <BranchingMethod v-for="method in methods" :key="method" :variant="method" :copy="copy" :chrome="chrome" />
  </div>
</template>

<style scoped>
.branch-sections {
  display: grid;
  gap: 20px;
}

.branch-note {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
</style>
