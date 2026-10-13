<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Copy as CopyIcon, Pencil as PencilIcon, RefreshCw as RefreshCwIcon, GitFork as GitForkIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';
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
  <section class="branch-demo" :aria-label="copy.label" data-testid="branch-demo" data-docs-animation="branch-path">
    <div class="branch-map" aria-hidden="true">
      <div class="map-heading"><GitForkIcon :size="16" /><span>CONVERSATION PATHS</span><span class="path-count">2</span></div>
      <svg viewBox="0 0 600 136" class="branch-lines" focusable="false">
        <path class="branch-rail" d="M300 23V53Q300 64 280 64H155Q130 64 130 88V108M300 53Q300 64 320 64H445Q470 64 470 88V108" />
        <path class="branch-travel" :d="selected === 0 ? 'M300 23V53Q300 64 280 64H155Q130 64 130 88V108' : 'M300 23V53Q300 64 320 64H445Q470 64 470 88V108'" />
        <circle cx="300" cy="23" r="8" class="root-node" />
        <circle cx="130" cy="108" r="8" :class="selected === 0 ? 'active-node' : 'saved-node'" />
        <circle cx="470" cy="108" r="8" :class="selected === 1 ? 'active-node' : 'saved-node'" />
        <text x="300" y="17" text-anchor="middle" class="root-label">Shared prompt</text>
      </svg>
      <div class="map-labels"><span>Original</span><span>Alternative</span></div>
    </div>
    <div class="branch-choices"><button type="button" :disabled="availability === 'static'" :aria-pressed="selected === 0" data-testid="branch-original" @click="selectBranch({ branch: 0 })">{{ copy.choices[0] }}</button><button type="button" :disabled="availability === 'static'" :aria-pressed="selected === 1" data-testid="branch-alternative" @click="selectBranch({ branch: 1 })">{{ copy.choices[1] }}</button></div>
    <div class="conversation-preview">
      <div class="user-line"><span class="role-avatar" aria-hidden="true">U</span><p class="prompt">{{ copy.prompt }}</p></div>
      <div class="assistant-line"><img :src="logo" width="27" height="27" alt=""><div class="assistant-body"><p class="reply" aria-live="polite" data-testid="branch-reply">{{ copy.replies[selected] }}</p><div class="message-tools" aria-hidden="true"><CopyIcon :size="14" /><PencilIcon :size="14" /><RefreshCwIcon :size="14" /><GitForkIcon :size="14" /></div></div></div>
    </div>
    <div class="branch-demo-bottom"><button class="reset" type="button" :disabled="availability === 'static'" data-testid="branch-reset" @click="selectBranch({ branch: 0 })">{{ copy.reset }}</button><p class="caption">{{ copy.note }}</p></div>
  </section>
</template>

<style scoped>
.branch-demo {
  border: 1px solid var(--line-strong);
  border-radius: 20px;
  overflow: hidden;
  background: var(--surface);
}

.branch-map {
  background: linear-gradient(145deg,var(--surface-2),var(--bg));
  padding: 22px 26px 10px;
}

.map-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--muted);
  font: 10px/1.5 ui-sans-serif,system-ui,sans-serif;
  letter-spacing: .1em;
}

.path-count {
  margin-left: auto;
  border: 1px solid var(--line);
  padding: 2px 8px;
  border-radius: 5px;
  font-variant-numeric: tabular-nums;
}

.branch-lines {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
  margin-top: 8px;
}

.branch-rail,.branch-travel {
  fill: none;
  stroke-width: 2;
}

.branch-rail {
  stroke: var(--line-strong);
}

.branch-travel {
  stroke: var(--blue);
  stroke-dasharray: 30 290;
  animation: docs-branch-travel 5s linear infinite;
}

.root-node {
  fill: var(--blue);
  stroke: var(--surface);
  stroke-width: 4;
}

.root-label {
  fill: var(--muted);
  font: 10px ui-sans-serif,system-ui,sans-serif;
  transform: translateY(-14px);
}

.active-node {
  fill: var(--blue);
  stroke: color-mix(in srgb,var(--blue) 20%,transparent);
  stroke-width: 10;
}

.saved-node {
  fill: var(--surface);
  stroke: var(--line-strong);
  stroke-width: 2;
}

.map-labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  text-align: center;
  color: var(--subtle);
  font: 10px/1.4 ui-sans-serif,system-ui,sans-serif;
  padding-bottom: 10px;
}

.branch-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 18px 26px;
  border-bottom: 1px solid var(--line);
}

.branch-choices button {
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--muted);
  border-radius: 10px;
  padding: 13px;
  font-size: 13px;
  text-align: center;
}

.branch-choices button[aria-pressed="true"] {
  border-color: var(--blue);
  background: color-mix(in srgb, var(--blue-strong) 12%, var(--surface));
  color: var(--text);
}

.branch-choices button:disabled,.reset:disabled {
  cursor: default;
}

.conversation-preview {
  background: #111827;
  color: #e5e7eb;
  padding: 26px;
}

.user-line,.assistant-line {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.role-avatar {
  border-radius: 8px;
  background: #374151;
  color: #9ca3af;
  width: 27px;
  height: 27px;
  flex: 0 0 27px;
  display: grid;
  place-items: center;
  font-size: 11px;
}

.branch-demo .prompt {
  margin: 0;
  padding: 10px 14px;
  background: #1f2937;
  border: 1px solid #374151;
  border-radius: 0 12px 12px 12px;
  font-size: 13px;
  line-height: 1.9;
  color: #e5e7eb;
}

.assistant-line {
  margin-top: 25px;
}

.assistant-body {
  flex: 1;
  min-width: 0;
}

.branch-demo .reply {
  margin: 0;
  min-height: 88px;
  line-height: 1.95;
  font-size: 14px;
  color: #e5e7eb;
}

.assistant-line img {
  flex: 0 0 27px;
}

.message-tools {
  display: flex;
  gap: 17px;
  color: #6b7280;
  padding-top: 12px;
}

.branch-demo-bottom {
  padding: 18px 26px;
}

.reset {
  background: transparent;
  border: 0;
  color: var(--blue);
  padding: 3px 0 10px;
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 4px;
}

.branch-demo .caption {
  margin: 0;
  font-size: 11px;
}

@keyframes docs-branch-travel {
  from {
    stroke-dashoffset: 0;
  }
  to {
    stroke-dashoffset: -320;
  }
}

@media(max-width:420px) {
  .branch-map,.branch-choices,.conversation-preview,.branch-demo-bottom {
    padding-inline: 16px;
  }
  .branch-choices {
    gap: 7px;
  }
  .branch-choices button {
    padding: 11px 6px;
    font-size: 12px;
  }
  .branch-demo .reply {
    min-height: 126px;
    font-size: 13px;
  }
  .root-label {
    font-size: 12px;
  }
}
</style>
