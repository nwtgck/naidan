<script setup lang="ts">
import BranchingMethod from './BranchingMethod.vue';
import RenderText from '../../components/RenderText';
import { readBranchingMessages } from './messages';
import type { DocsLocale } from '../../navigation/routes';

const { locale } = defineProps<{ locale: DocsLocale }>();
const { messages, chrome } = readBranchingMessages({ locale });

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
    <p class="branch-note"><RenderText :node="messages.note()" /></p>
    <BranchingMethod v-for="method in methods" :key="method" :variant="method" :copy="messages" :chrome="chrome" />
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
