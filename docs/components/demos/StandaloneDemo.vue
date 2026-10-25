<script setup lang="ts">
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, FileCodeIcon, FolderIcon, FolderOpenIcon, MinusIcon, MoreHorizontalIcon, MousePointer2Icon, RotateCwIcon, SendIcon, SquareIcon, XIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';
type StandaloneDemoMessages = typeof import('../../pages/standalone/messages/en').messages | typeof import('../../pages/index/messages/en').messages;

defineProps<{ messages: StandaloneDemoMessages }>();

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
  <div class="standalone-demo" data-testid="standalone-demo" data-docs-animation="open-local-html" aria-hidden="true">
    <div class="launch-heading"><b>{{ messages.double_click_index_html }}</b><span><ArrowRightIcon :size="13" />{{ messages.open_in_browser }}</span></div>
    <div class="standalone-stage">
      <div class="explorer-window" data-testid="standalone-explorer">
        <div class="window-title"><span><FolderOpenIcon :size="13" />{{ messages.file_explorer }}</span><span class="window-controls"><MinusIcon :size="11" /><SquareIcon :size="10" /><XIcon :size="11" /></span></div>
        <div class="explorer-toolbar"><ArrowLeftIcon :size="13" /><ArrowRightIcon :size="13" /><div class="folder-path"><FolderIcon :size="13" /><code>naidan-standalone</code><ChevronRightIcon :size="12" /></div><MoreHorizontalIcon :size="14" /></div>
        <div class="file-table">
          <div class="file-table-head"><span>{{ messages.file_name_column }}</span><span>{{ messages.file_type_column }}</span></div>
          <div class="file-row"><span><FolderIcon :size="16" /><code>assets/</code></span><small>{{ messages.folder }}</small></div>
          <div class="file-row index-row" data-testid="standalone-index-file"><span><FileCodeIcon :size="16" /><code>index.html</code></span><small>{{ messages.html_document }}</small><MousePointer2Icon class="open-pointer" :size="20" /></div>
        </div>
        <div class="explorer-note">{{ messages.keep_extracted_files_together }}</div>
      </div>
      <div class="browser-window" data-testid="standalone-browser">
        <div class="browser-tabs"><span><img :src="logo" alt="" width="12" height="12">Naidan<XIcon :size="10" /></span><span class="window-controls"><MinusIcon :size="11" /><SquareIcon :size="10" /><XIcon :size="11" /></span></div>
        <div class="browser-address"><RotateCwIcon :size="12" /><code>file:///…/naidan-standalone/index.html</code></div>
        <div class="standalone-app"><img :src="logo" width="29" height="29" alt=""><b>Naidan</b><p>{{ messages.new_chat }}</p><div class="model-preparation">{{ messages.choose_a_model_to_begin }}</div><div class="standalone-composer"><span>{{ messages.type_a_message }}</span><SendIcon :size="13" /></div></div>
        <div class="browser-status"><span>{{ messages.browser_session }}</span><span>{{ messages.no_app_server }}</span></div>
      </div>
    </div>
    <p class="standalone-note">{{ messages.extract_the_zip_first }}</p>
  </div>
</template>

<style scoped>
.standalone-demo {
  min-width: 0;
  max-width: 680px;
  padding: 17px;
  border: 1px solid var(--line-strong);
  border-radius: 15px;
  background: var(--surface);
  font: 11px/1.6 ui-sans-serif, system-ui, sans-serif;
}
.launch-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 14px;
  margin-bottom: 13px;
  color: var(--text);
}
.launch-heading b {
  font-size: 12px;
  font-weight: 600;
}
.launch-heading > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--muted);
}
.launch-heading svg {
  flex-shrink: 0;
}
.standalone-stage {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 12px;
  padding-bottom: 5px;
}
.explorer-window {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--surface-2);
}
.window-title, .browser-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
.window-title > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--muted);
}
.window-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  color: var(--subtle);
}
.explorer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px;
  color: var(--muted);
}
.explorer-toolbar > svg {
  flex-shrink: 0;
}
.folder-path {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1;
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
}
.folder-path code {
  min-width: 0;
  font: 9px/1.6 ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.folder-path svg {
  flex-shrink: 0;
}
.file-table {
  padding: 0 8px 8px;
}
.file-table-head, .file-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, .85fr);
  gap: 6px;
  padding: 7px 8px;
}
.file-table-head {
  padding-block: 3px 7px;
  color: var(--subtle);
  font-size: 9px;
}
.file-row {
  position: relative;
  align-items: center;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--muted);
}
.file-row > span {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.file-row svg {
  flex-shrink: 0;
  color: var(--blue);
}
.file-row code {
  font: 10px/1.6 ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.file-row small {
  font-size: 8px;
  overflow-wrap: anywhere;
  padding-right: 10px;
}
.index-row {
  background: color-mix(in srgb, var(--blue) 10%, transparent);
  border-color: color-mix(in srgb, var(--blue) 25%, transparent);
}
.open-pointer {
  position: absolute;
  right: 22%;
  top: 20px;
  z-index: 2;
  color: var(--text) !important;
  fill: var(--surface);
  filter: drop-shadow(0 1px 2px #0005);
  opacity: 0;
  animation: docs-index-double-click 8s linear infinite;
}
.explorer-note {
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  color: var(--subtle);
  font-size: 8px;
  overflow-wrap: anywhere;
}
.browser-window {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 10px 25px #0003;
  transform-origin: center;
  animation: docs-open-browser 8s ease-out infinite;
}
.browser-tabs {
  border-color: var(--line);
  background: var(--surface-2);
  border-radius: 8px 8px 0 0;
  padding: 6px 8px;
}
.browser-tabs > span:first-child {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  background: var(--surface-3);
  border-radius: 5px 5px 0 0;
  font-size: 9px;
}
.browser-tabs > span:first-child svg {
  margin-left: 15px;
}
.browser-address {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 6px 8px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
  color: var(--muted);
}
.browser-address svg {
  flex-shrink: 0;
  margin-top: 3px;
}
.browser-address code {
  flex: 1;
  min-width: 0;
  border-radius: 4px;
  background: var(--bg);
  padding: 3px 6px;
  font: 8px/1.6 ui-monospace, monospace;
  overflow-wrap: anywhere;
  white-space: normal;
}
.standalone-app {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 12px 12px;
}
.standalone-app b {
  font-size: 16px;
  letter-spacing: -.04em;
  margin-top: 4px;
}
.standalone-app p {
  font-size: 9px;
  line-height: 1.5;
  color: var(--muted);
  margin: 1px 0 8px;
}
.model-preparation {
  align-self: stretch;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  font-size: 8px;
  line-height: 1.6;
  color: var(--muted);
}
.standalone-composer {
  display: flex;
  align-items: center;
  align-self: stretch;
  gap: 8px;
  padding: 8px;
  margin-top: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--muted);
}
.standalone-composer span {
  min-width: 0;
  flex: 1;
  font-size: 8px;
  overflow-wrap: anywhere;
}
.standalone-composer svg {
  flex-shrink: 0;
  color: var(--blue);
}
.browser-status {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 10px;
  border-top: 1px solid var(--line);
  padding: 6px 9px;
  font-size: 8px;
  color: var(--muted);
}
.standalone-note {
  color: var(--subtle);
  font-size: 9px;
  margin: 6px 0 0;
}
@keyframes docs-index-double-click {
  0%, 8% {
    opacity: 0;
    transform: translate(20px, 12px);
  }
  16% {
    opacity: 1;
    transform: translate(0, 0);
  }
  19%, 23% {
    opacity: 1;
    transform: scale(.78);
  }
  21%, 25%, 32% {
    opacity: 1;
    transform: scale(1);
  }
  40%, 100% {
    opacity: 0;
    transform: scale(1);
  }
}
@keyframes docs-open-browser {
  0%, 31% {
    opacity: 0;
    transform: translateY(10px) scale(.97);
  }
  42%, 88% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  100% {
    opacity: 0;
    transform: translateY(0) scale(1);
  }
}
html:has(#docs-pause-motion:checked) .browser-window {
  animation: none;
}
html:has(#docs-pause-motion:checked) .open-pointer {
  animation: none;
}
@media(max-width: 520px) {
  .standalone-demo {
    padding: 13px;
  }
  .standalone-stage {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .explorer-window {
    grid-column: 1;
    grid-row: 1;
  }
  .browser-window {
    grid-column: 1;
    grid-row: 2;
    margin-top: 0;
  }
  .file-row small {
    font-size: 9px;
  }
}
</style>
