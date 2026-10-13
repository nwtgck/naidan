<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { BranchingCopy } from '../../site/messages';

defineProps<{ copy: BranchingCopy }>();
const selected = ref<0 | 1>(0);
const availability = ref<'static' | 'interactive'>('static');
onMounted(() => {
  availability.value = 'interactive';
});

function selectBranch({ branch }: { branch: 0 | 1 }): void {
  selected.value = branch;
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <section
    class="branch-demo"
    :aria-label="copy.label"
    data-testid="branch-demo"
  >
    <p class="prompt">{{ copy.prompt }}</p>
    <div
      class="fork"
      aria-hidden="true"
    >┌────────┴────────┐</div>
    <div class="branch-choices"><button
      type="button"
      :disabled="availability === 'static'"
      :aria-pressed="selected === 0"
      data-testid="branch-original"
      @click="selectBranch({ branch: 0 })"
    >{{ copy.choices[0] }}</button><button
      type="button"
      :disabled="availability === 'static'"
      :aria-pressed="selected === 1"
      data-testid="branch-alternative"
      @click="selectBranch({ branch: 1 })"
    >{{ copy.choices[1] }}</button></div>
    <p
      class="reply"
      aria-live="polite"
      data-testid="branch-reply"
    >{{ copy.replies[selected] }}</p>
    <button
      class="reset"
      type="button"
      :disabled="availability === 'static'"
      data-testid="branch-reset"
      @click="selectBranch({ branch: 0 })"
    >{{ copy.reset }}</button>
    <p class="caption">{{ copy.note }}</p>
  </section>
</template>

<style scoped>
.branch-demo {
  border: 1px solid var(--line-strong);
  border-radius: 19px;
  padding: 26px;
  background: var(--surface);
}

.prompt {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
}

.fork {
  font-family: ui-monospace, monospace;
  text-align: center;
  color: var(--subtle);
  overflow: hidden;
}

.branch-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 10px 0 22px;
}

.branch-choices button {
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--muted);
  border-radius: 10px;
  padding: 13px;
  font-size: 13px;
}

.branch-choices button[aria-pressed="true"] {
  border-color: var(--blue);
  background: color-mix(in srgb, var(--blue-strong) 15%, var(--surface));
  color: var(--text);
}

.branch-choices button:disabled,
.reset:disabled {
  cursor: default;
}

.reply {
  border-left: 2px solid var(--blue);
  padding: 15px 19px;
  min-height: 115px;
  line-height: 1.9;
  color: var(--text);
}

.reset {
  background: transparent;
  border: 0;
  color: var(--blue);
  padding: 9px 0;
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 4px;
}

.caption {
  margin-bottom: 0;
}

@media(max-width:420px) {
  .branch-demo {
    padding: 17px;
  }

  .branch-choices {
    grid-template-columns: 1fr;
  }

  .reply {
    min-height: 0;
  }
}
</style>
