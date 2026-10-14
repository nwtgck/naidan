<script setup lang="ts">
import { DatabaseIcon, GhostIcon, HardDriveIcon } from 'lucide-vue-next';
import type { StorageChoiceDemoCopy } from '../../pages/index/strings/storage-demo/en';

defineProps<{ copy: StorageChoiceDemoCopy }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // ESLint-required test boundary; this static replica exposes no test API.
    },
  }) || {}),
});
</script>

<template>
  <div class="storage-choice" data-testid="storage-choice-demo" data-docs-animation="storage-choice" aria-hidden="true">
    <div class="storage-choice-heading">
      <DatabaseIcon :size="17" />
      <strong>{{ copy.sectionTitle }}</strong>
    </div>
    <div class="storage-choice-label">{{ copy.fieldLabel }}</div>
    <div class="storage-choice-list">
      <div class="storage-choice-card storage-choice-card--opfs" data-testid="storage-choice-opfs">
        <span class="storage-choice-icon"><HardDriveIcon :size="17" /></span>
        <div class="storage-choice-text">
          <strong>{{ copy.options.opfs.title }}</strong>
          <p>{{ copy.options.opfs.description }}</p>
        </div>
      </div>
      <div class="storage-choice-card" data-testid="storage-choice-local">
        <span class="storage-choice-icon"><HardDriveIcon :size="17" /></span>
        <div class="storage-choice-text">
          <strong>{{ copy.options.local.title }}</strong>
          <p>{{ copy.options.local.description }}</p>
        </div>
      </div>
      <div class="storage-choice-card storage-choice-card--memory" data-testid="storage-choice-memory">
        <span class="storage-choice-icon"><GhostIcon :size="17" /></span>
        <div class="storage-choice-text">
          <strong>{{ copy.options.memory.title }}</strong>
          <p>{{ copy.options.memory.description }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.storage-choice {
  --choice-blue-bg: color-mix(in srgb, #3b82f6 12%, var(--surface));
  --choice-purple-bg: color-mix(in srgb, #a855f7 12%, var(--surface));
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  background: var(--surface-2);
  box-shadow: var(--panel-shadow);
}

.storage-choice-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}

.storage-choice-heading svg {
  flex: none;
  color: var(--blue);
}

.storage-choice-label {
  margin: 13px 2px 9px;
  color: var(--subtle);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .07em;
  line-height: 1.5;
  text-transform: uppercase;
}

.storage-choice-list {
  display: grid;
  gap: 8px;
}

.storage-choice-card {
  display: grid;
  grid-template-columns: 31px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  min-width: 0;
  padding: 11px 12px;
  border: 2px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: 0 2px 6px rgba(0, 0, 0, .035);
}

.storage-choice-icon {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--muted);
}

.storage-choice-text {
  min-width: 0;
}

.storage-choice-text strong {
  display: block;
  color: var(--text);
  font-size: 13px;
  font-weight: 750;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.storage-choice-text p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.storage-choice-card--opfs {
  border-color: #3b82f6;
  background: var(--choice-blue-bg);
  animation: storage-select-opfs 10s steps(1, end) infinite;
}

.storage-choice-card--memory {
  animation: storage-select-memory 10s steps(1, end) infinite;
}

@keyframes storage-select-opfs {
  0%, 49%, 100% { border-color: #3b82f6; background: var(--choice-blue-bg); }
  50%, 99% { border-color: var(--line); background: var(--surface); }
}

@keyframes storage-select-memory {
  0%, 49%, 100% { border-color: var(--line); background: var(--surface); }
  50%, 99% { border-color: #a855f7; background: var(--choice-purple-bg); }
}

@media (max-width: 620px) {
  .storage-choice { padding: 14px; }
  .storage-choice-card { padding: 10px; }
}
</style>
