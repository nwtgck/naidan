<script setup lang="ts">
import { FolderIcon, FileTextIcon, LockKeyholeIcon, CopyIcon } from 'lucide-vue-next';

defineProps<{ messages: typeof import('../../pages/file-access/messages/en').messages }>();


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
  <div class="folder-demo" data-testid="folder-access-demo" data-docs-animation="folder-copy" aria-hidden="true">
    <section class="folder-source"><div class="folder-heading"><FolderIcon :size="19" /><b>{{ messages.on_your_device }}</b></div><div class="directory-name">project/</div><div class="file-row"><FileTextIcon :size="14" /><span>notes.txt</span><span class="file-selected">✓</span></div><div class="file-row"><FileTextIcon :size="14" /><span>plan.md</span><span class="file-selected">✓</span></div><div class="unselected-folder"><FolderIcon :size="13" /><span>{{ messages.other_folders }}</span><LockKeyholeIcon :size="13" /></div></section>
    <div class="copy-bridge"><CopyIcon :size="18" /><span>{{ messages.folder_copy }}</span><div class="copy-track"><i /></div></div>
    <section class="folder-target"><div class="folder-heading"><FolderIcon :size="19" /><b>Naidan</b></div><div class="folder-access"><span>{{ messages.mounted_folder }}</span><strong>{{ messages.read_only }}</strong></div><div class="copied-file"><FileTextIcon :size="14" /><span>notes.txt</span><small>{{ messages.copy_label }}</small></div><div class="copied-file"><FileTextIcon :size="14" /><span>plan.md</span><small>{{ messages.copy_label }}</small></div><div class="access-key"><LockKeyholeIcon :size="12" />{{ messages.reading_allowed_writing_disabled }}</div></section>
  </div>
</template>

<style scoped>
.folder-demo {
  display: grid;
  grid-template-columns: 1fr 82px 1fr;
  gap: 15px;
  padding: 29px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 20px;
  font: 12px/1.7 ui-sans-serif,system-ui,sans-serif;
}

.folder-source,.folder-target {
  min-width: 0;
}

.folder-heading {
  display: flex;
  gap: 9px;
  align-items: center;
  color: var(--text);
  padding-bottom: 18px;
}

.folder-heading svg {
  color: var(--blue);
}

.folder-heading b {
  font-weight: 600;
}

.directory-name {
  color: var(--muted);
  font-size: 11px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
}

.file-row,.copied-file {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  padding: 9px 10px;
  margin-top: 5px;
  background: var(--surface-2);
  color: var(--muted);
}

.file-selected {
  color: var(--green);
  margin-left: auto;
}

.unselected-folder {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 16px 10px 0;
  opacity: .6;
  font-size: 10px;
}

.unselected-folder svg:last-child {
  margin-left: auto;
}

.copy-bridge {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
  justify-content: center;
  color: var(--blue);
  font-size: 9px;
}

.copy-track {
  height: 1px;
  width: 60px;
  margin-top: 6px;
  background: var(--line-strong);
  position: relative;
}

.copy-track i {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--blue);
  top: -3px;
  animation: docs-copy-packet 6s ease-in-out infinite;
}

.folder-target {
  padding: 16px;
  background: color-mix(in srgb,var(--blue-strong) 6%,var(--bg));
  border: 1px solid #3b82f64d;
  border-radius: 13px;
}

.folder-target .folder-heading {
  padding-bottom: 6px;
}

.folder-access {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 9px;
  color: var(--muted);
  margin: 9px 0;
}

.folder-access strong {
  font-size: 8px;
  color: var(--green);
  letter-spacing: .07em;
}

.copied-file {
  border: 1px solid var(--line-strong);
  animation: docs-copy-arrival 6s ease-in-out infinite;
}

.copied-file:nth-of-type(4) {
  animation-delay: .7s;
}

.copied-file small {
  margin-left: auto;
  font-size: 8px;
  color: var(--blue);
}

.access-key {
  color: var(--subtle);
  font-size: 8px;
  margin-top: 14px;
  display: flex;
  gap: 5px;
  align-items: center;
}

@keyframes docs-copy-packet {
  0%,10% {
    transform: translateX(0);
    opacity: 0;
  }
  25% {
    opacity: 1;
  }
  60% {
    transform: translateX(54px);
    opacity: 1;
  }
  75%,100% {
    transform: translateX(54px);
    opacity: 0;
  }
}

@keyframes docs-copy-arrival {
  0%,30%,100% {
    border-color: var(--line-strong);
  }
  55%,75% {
    border-color: var(--blue);
    box-shadow: 0 0 0 3px #3b82f60a;
  }
}

html:has(#docs-pause-motion:checked) .folder-demo .copy-track i {
  animation: none!important;
  opacity: 0;
}

html:has(#docs-pause-motion:checked) .folder-demo .copied-file {
  animation: none !important;
  border-color: var(--blue);
  box-shadow: 0 0 0 3px #3b82f60a;
}

@media(prefers-reduced-motion:reduce) {
  .folder-demo .copy-track i {
    animation: none!important;
    opacity: 0;
  }
  .folder-demo .copied-file {
    animation: none!important;
    border-color: var(--blue);
    box-shadow: 0 0 0 3px #3b82f60a;
  }
}

@media(max-width:640px) {
  .folder-demo {
    grid-template-columns: 1fr;
    padding: 20px;
    gap: 16px;
  }
  .copy-bridge {
    flex-direction: row;
  }
  .copy-track {
    width: 60px;
    margin: 0 0 0 8px;
  }
  .folder-heading {
    padding-bottom: 5px;
  }
  .unselected-folder {
    padding-top: 10px;
  }
}
</style>
