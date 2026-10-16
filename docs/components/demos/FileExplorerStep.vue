<script setup lang="ts">
import {
  ArchiveIcon, ChevronLeftIcon, ChevronRightIcon, Columns3Icon, CopyIcon, DownloadIcon,
  EyeIcon, FileIcon, FilePlusIcon, FileTextIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon,
  FolderSearchIcon,
  HistoryIcon, LayoutGridIcon, ListIcon, LockIcon, LockOpenIcon, MoreVerticalIcon,
  MousePointer2Icon, RefreshCwIcon, SearchIcon, SettingsIcon, UploadIcon, XIcon,
} from 'lucide-vue-next';

defineProps<{
  stage: 'open' | 'browse' | 'upload' | 'download' | 'organize';
  messages: typeof import('../../pages/file-explorer/messages/en').messages;
}>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="camera" :class="`stage-${stage}`" :data-docs-animation="`explorer-${stage}`" :data-testid="`explorer-step-${stage}`" aria-hidden="true">
    <div v-if="stage === 'open'" class="entry-scene">
      <aside class="entry-sidebar">
        <strong>{{ messages.app_name }}</strong>
        <div class="entry-spacer" />
        <div class="entry-actions"><span class="entry-settings"><SettingsIcon :size="18" /></span><span class="entry-more"><MoreVerticalIcon :size="18" /><MousePointer2Icon class="pointer" :size="19" /></span></div>
        <div class="entry-menu">
          <small>{{ messages.quick_access }}</small>
          <span><HistoryIcon :size="16" />{{ messages.recent_chats }}</span>
          <strong><FolderSearchIcon :size="16" />{{ messages.file_explorer }}</strong>
        </div>
      </aside>
      <div class="entry-main"><span>{{ messages.app_name }}</span></div>
      <div class="open-shade" />
      <div class="open-dialog">
        <header><strong>{{ messages.opfs_explorer_title }}</strong><XIcon :size="15" /></header>
        <div class="open-toolbar"><ChevronLeftIcon :size="14" /><strong>{{ messages.opfs_root }}</strong><span><ListIcon :size="14" /><EyeIcon :size="14" /><LockIcon :size="14" /></span></div>
        <div class="open-content"><span><FolderIcon :size="18" />{{ messages.project_folder }}</span><small>{{ messages.initial_item_count }}</small></div>
      </div>
    </div>

    <div v-else class="workbench">
      <div class="explorer-head"><strong>{{ messages.opfs_explorer_title }}</strong><XIcon :size="15" /></div>
      <div class="explorer-tools">
        <div class="breadcrumbs"><ChevronLeftIcon :size="15" /><span>{{ messages.opfs_root }}</span><ChevronRightIcon :size="12" /><strong>{{ messages.project_folder }}</strong></div>
        <div class="toolset view-switch"><LayoutGridIcon :size="15" /><span class="active"><ListIcon :size="15" /></span><Columns3Icon :size="15" /></div>
        <div class="toolset actions"><EyeIcon :size="15" /><span class="lock-icon" :class="{ unlocked: stage === 'upload' }"><LockIcon v-if="stage !== 'upload'" data-testid="explorer-lock-closed" :size="15" /><LockOpenIcon v-if="stage === 'upload'" data-testid="explorer-lock-open" :size="15" /><LockOpenIcon v-if="stage === 'organize'" class="organize-unlocked" data-testid="explorer-lock-open" :size="15" /></span><SearchIcon :size="15" /><span class="upload-icon"><UploadIcon :size="15" /></span><FilePlusIcon :size="15" /><FolderPlusIcon :size="15" /><RefreshCwIcon :size="15" /></div>
      </div>
      <div class="explorer-main">
        <div class="file-list">
          <div class="list-head"><strong>{{ messages.name_column }}</strong><span>{{ messages.size_column }}</span><span>{{ messages.modified_column }}</span><span>{{ messages.type_column }}</span></div>
          <div class="folder-row" :class="{ selected: stage === 'download' }"><FolderIcon :size="17" /><strong>{{ messages.output_folder }}</strong><span class="row-end">{{ messages.folder_type }}</span></div>
          <div class="file-row" :class="{ selected: stage === 'browse' || stage === 'organize' }"><FileTextIcon :size="17" /><strong>{{ messages.notes_filename }}</strong><span class="row-end">1 KB</span></div>
          <div v-if="stage === 'organize'" class="file-row second"><FileIcon :size="17" /><strong>{{ messages.report_filename }}</strong><span class="row-end">1 KB</span></div>
        </div>
        <div class="preview-pane"><div class="preview-head"><strong>{{ stage === 'browse' ? messages.notes_filename : messages.preview_label }}</strong><XIcon :size="14" /></div><div class="preview-empty">{{ messages.preview_label }}</div><div class="preview-text"><small>.md</small><pre>{{ messages.project_note_content }}</pre></div></div>
      </div>
      <div class="status-bar"><span v-if="stage === 'organize'"><span class="before-count">{{ messages.initial_item_count }}</span><span class="after-count">{{ messages.organized_item_count }}</span></span><span v-else>{{ messages.initial_item_count }}</span><span v-if="stage !== 'upload'">{{ messages.selected_count }}</span></div>

      <div v-if="stage === 'upload'" class="upload-scene">
        <div class="action-tip"><UploadIcon :size="15" />{{ messages.upload_files_action }}</div>
        <div class="overlay-shade" />
        <div class="zip-dialog">
          <header><strong><ArchiveIcon :size="17" />{{ messages.zip_upload_title }}</strong><XIcon :size="15" /></header>
          <div class="zip-grid"><div class="zip-choices"><div class="archive-name"><ArchiveIcon :size="20" /><strong>{{ messages.archive_filename }}</strong></div><strong class="option">{{ messages.keep_zip_file }}</strong><strong class="option chosen">{{ messages.extract_and_place }}</strong><small>{{ messages.project_root_handling }}</small><span class="root-choice">{{ messages.keep_project_root }}</span><span class="root-choice selected-choice">{{ messages.place_project_contents }}</span></div><div class="zip-preview"><strong>{{ messages.placement_preview }}</strong><small>{{ messages.not_changed_yet }}</small><div class="preview-row"><FolderIcon :size="16" /><span>{{ messages.output_folder }}/</span><em>{{ messages.planned_addition }}</em></div><div class="preview-row"><FileTextIcon :size="16" /><span>{{ messages.notes_filename }}</span><em>{{ messages.planned_overwrite }}</em></div></div></div>
          <footer><span>{{ messages.upload_files_action }}</span></footer>
        </div>
      </div>

      <div v-if="stage === 'download'" class="download-scene">
        <div class="context-menu"><span><FolderOpenIcon :size="15" />{{ messages.open_action }}</span><strong><DownloadIcon :size="15" />{{ messages.download_action }}</strong></div>
        <div class="overlay-shade" />
        <div class="download-dialog">
          <header><strong>{{ messages.download_directory }}</strong><XIcon :size="15" /></header>
          <div class="download-fields"><label><strong>{{ messages.archive_name }}</strong><span class="archive-field">{{ messages.output_folder }} <small>{{ messages.archive_suffix }}</small></span></label><label><strong>{{ messages.exclude_items }}</strong><span class="exclusion-field">{{ messages.report_filename }} <XIcon :size="13" /></span></label></div>
          <footer><strong><DownloadIcon :size="15" />{{ messages.download_action }}</strong></footer>
        </div>
      </div>

      <div v-if="stage === 'organize'" class="organize-scene">
        <div class="lock-tip"><LockIcon :size="15" />{{ messages.locked_status }}</div>
        <div class="folder-prompt"><strong>{{ messages.new_folder }}</strong><span>{{ messages.output_folder }}</span><b>{{ messages.create_action }}</b></div>
        <div class="organize-menu"><span><CopyIcon :size="15" />{{ messages.copy_action }}</span><strong>{{ messages.paste_action }}</strong><span>{{ messages.rename_action }}</span><span>{{ messages.delete_action }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.camera {
  --p:var(--surface);
  --f:var(--surface-2);
  --l:var(--line-strong);
  --t:var(--text);
  --m:var(--muted);
  --a:var(--blue);
  position: relative;
  width: 100%;
  max-width: 720px;
  height: 344px;
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid var(--l);
  border-radius: 15px;
  background: var(--p);
  box-shadow: var(--panel-shadow);
  color: var(--t);
  font: 12px/1.45 ui-sans-serif,system-ui,sans-serif;
  text-align: left;
}
.camera * {
  box-sizing: border-box;
}
.camera svg {
  flex: none;
}
.entry-scene {
  position: absolute;
  inset: 0;
  display: flex;
  background: var(--f);
}
.entry-sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 170px;
  flex: none;
  padding: 16px 11px;
  border-right: 1px solid var(--l);
  background: var(--p);
}
.entry-sidebar > strong {
  font-size: 19px;
}
.entry-spacer {
  flex: 1;
}
.entry-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.entry-actions > span {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  border-radius: 9px;
  border: 1px solid var(--l);
  color: var(--m);
}
.entry-more {
  position: relative;
}
.pointer {
  position: absolute;
  right: -8px;
  bottom: -8px;
  fill: var(--p);
  filter: drop-shadow(0 1px 2px #0008);
  animation: pointer-tap 9s linear infinite;
}
.entry-main {
  display: grid;
  place-items: center;
  flex: 1;
  color: var(--m);
  font-size: 17px;
}
.entry-menu {
  position: absolute;
  z-index: 2;
  left: 135px;
  bottom: 50px;
  width: 225px;
  padding: 8px;
  border: 1px solid var(--l);
  border-radius: 11px;
  background: var(--p);
  box-shadow: 0 10px 30px #0003;
  animation: entry-menu-leave 9s linear infinite;
}
.entry-menu small {
  display: block;
  padding: 5px 9px;
  color: var(--m);
  font-size: 10px;
  text-transform: uppercase;
  font-weight: 750;
}
.entry-menu span,.entry-menu strong {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px;
  border-radius: 7px;
  font-weight: 650;
}
.entry-menu strong {
  background: color-mix(in srgb,var(--a) 12%,var(--p));
  color: var(--a);
}
.open-shade {
  position: absolute;
  z-index: 3;
  inset: 0;
  background: #1018279c;
  opacity: 0;
  animation: open-arrive 9s linear infinite;
}
.open-dialog {
  position: absolute;
  z-index: 4;
  top: 49px;
  left: 12%;
  width: 76%;
  height: 244px;
  border: 1px solid var(--l);
  border-radius: 14px;
  background: var(--p);
  box-shadow: 0 18px 50px #0006;
  opacity: 0;
  animation: open-arrive 9s linear infinite;
}
.open-dialog header,.explorer-head,.zip-dialog header,.download-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--l);
  font-size: 13px;
}
.open-dialog header svg,.explorer-head svg,.zip-dialog header > svg,.download-dialog header svg {
  color: var(--m);
}
.open-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--l);
  color: var(--m);
}
.open-toolbar strong {
  color: var(--t);
  font-size: 11px;
}
.open-toolbar span {
  display: flex;
  gap: 10px;
  margin-left: auto;
}
.open-content {
  padding: 14px;
}
.open-content > span {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px;
  border-radius: 6px;
  color: var(--t);
}
.open-content > span svg {
  color: #eab308;
}
.open-content small {
  display: block;
  margin-top: 54px;
  color: var(--m);
}
.workbench {
  position: absolute;
  left: 0;
  top: 0;
  width: 820px;
  height: 344px;
  background: var(--p);
  transform: translateX(var(--x,0px));
  animation: workbench-pan 10s ease-in-out infinite;
}
.explorer-head {
  height: 43px;
  padding: 8px 14px;
}
.explorer-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 49px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--l);
}
.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  color: var(--m);
  font-size: 11px;
}
.breadcrumbs strong {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--t);
}
.toolset {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--m);
}
.toolset > * {
  flex: none;
}
.view-switch {
  gap: 3px;
  border: 1px solid var(--l);
  padding: 2px;
  border-radius: 7px;
}
.view-switch > * {
  padding: 3px;
}
.view-switch .active {
  color: white;
  background: var(--a);
  border-radius: 4px;
}
.actions {
  gap: 11px;
}
.lock-icon {
  display: grid;
  place-items: center;
  color: #d97706;
}
.lock-icon.unlocked {
  color: var(--m);
}
.explorer-main {
  display: flex;
  height: 222px;
}
.file-list {
  width: 548px;
  padding: 8px 12px;
}
.list-head {
  display: grid;
  grid-template-columns: 1fr 60px 88px 52px;
  gap: 7px;
  padding: 4px 5px 9px;
  border-bottom: 1px solid var(--l);
  color: var(--m);
  font-size: 10px;
}
.list-head span {
  text-align: right;
}
.folder-row,.file-row {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 35px;
  padding: 0 7px;
  border-radius: 5px;
}
.folder-row svg {
  color: #eab308;
}
.file-row svg {
  color: var(--m);
}
.folder-row strong,.file-row strong {
  min-width: 0;
  flex: 1;
  font-size: 11px;
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.folder-row.selected,.file-row.selected {
  background: var(--a);
  color: white;
}
.folder-row.selected svg,.file-row.selected svg {
  color: white;
}
.row-end {
  color: var(--m);
  font-size: 10px;
}
.selected .row-end {
  color: #e7f2ff;
}
.preview-pane {
  width: 272px;
  border-left: 1px solid var(--l);
  background: var(--f);
}
.preview-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  height: 37px;
  padding: 0 11px;
  border-bottom: 1px solid var(--l);
  font-size: 11px;
}
.preview-head strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-head svg {
  color: var(--m);
}
.preview-empty {
  display: grid;
  place-items: center;
  height: 160px;
  color: var(--m);
  font-size: 11px;
}
.preview-text {
  display: none;
  padding: 8px 11px;
  white-space: pre-wrap;
  opacity: 0;
  animation: preview-arrive 10s linear infinite;
}
.preview-text small {
  color: var(--m);
}
.preview-text pre {
  margin: 9px 0;
  font: 11px/1.55 ui-monospace,monospace;
  white-space: pre-wrap;
}
.stage-browse .preview-empty {
  display: none;
}
.stage-browse .preview-text {
  display: block;
}
.status-bar {
  display: flex;
  justify-content: space-between;
  padding: 7px 12px;
  border-top: 1px solid var(--l);
  color: var(--m);
  font-size: 10px;
}
.stage-open {
  background: var(--f);
}
.stage-browse .workbench {
  --x:-97px;
}
.stage-upload .workbench {
  --x:-165px;
}
.stage-download .workbench {
  --x:-160px;
}
.stage-organize .workbench {
  --x:0px;
}
.overlay-shade {
  position: absolute;
  z-index: 4;
  inset: 0;
  background: #101827a6;
  opacity: 0;
  animation: dialog-arrive 10s linear infinite;
}
.action-tip,.lock-tip {
  position: absolute;
  z-index: 3;
  top: 55px;
  right: 160px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--l);
  border-radius: 7px;
  background: var(--p);
  box-shadow: 0 6px 18px #0003;
  color: var(--t);
  font-size: 11px;
  animation: tip-leave 10s linear infinite;
}
.lock-tip {
  right: 211px;
}
.zip-dialog,.download-dialog {
  position: absolute;
  z-index: 5;
  top: 24px;
  left: calc((820px - 610px)/2);
  width: 610px;
  border: 1px solid var(--l);
  border-radius: 13px;
  background: var(--p);
  box-shadow: 0 18px 50px #0006;
  opacity: 0;
  animation: dialog-arrive 10s linear infinite;
}
.zip-dialog header strong {
  display: flex;
  align-items: center;
  gap: 8px;
}
.zip-grid {
  display: grid;
  grid-template-columns: 270px 1fr;
  min-height: 222px;
}
.zip-choices {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 13px;
  border-right: 1px solid var(--l);
  font-size: 11px;
}
.archive-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
  padding: 7px;
  border: 1px solid var(--l);
  border-radius: 7px;
}
.archive-name svg {
  color: #d97706;
}
.option,.root-choice {
  display: block;
  padding: 7px 9px;
  border: 1px solid var(--l);
  border-radius: 7px;
  font-weight: 550;
}
.option.chosen,.root-choice.selected-choice {
  border-color: var(--a);
  background: color-mix(in srgb,var(--a) 10%,var(--p));
  color: var(--a);
}
.zip-choices small {
  color: var(--m);
  font-weight: 700;
}
.zip-preview {
  padding: 13px;
  font-size: 11px;
}
.zip-preview > strong {
  display: block;
}
.zip-preview > small {
  display: block;
  margin: 3px 0 11px;
  color: var(--m);
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--l);
}
.preview-row span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-row svg {
  color: var(--m);
}
.preview-row em {
  color: var(--a);
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}
.preview-row:last-child em {
  color: #d97706;
}
.zip-dialog footer,.download-dialog footer {
  display: flex;
  justify-content: flex-end;
  padding: 9px 13px;
  border-top: 1px solid var(--l);
}
.zip-dialog footer span,.download-dialog footer strong {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  border-radius: 7px;
  background: var(--a);
  color: white;
  font-size: 11px;
}
.context-menu {
  position: absolute;
  z-index: 3;
  top: 130px;
  left: 165px;
  width: 180px;
  padding: 5px;
  border: 1px solid var(--l);
  border-radius: 10px;
  background: var(--p);
  box-shadow: 0 10px 27px #0003;
  animation: tip-leave 10s linear infinite;
}
.context-menu span,.context-menu strong {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
  color: var(--m);
  font-size: 11px;
}
.context-menu strong {
  border-radius: 6px;
  background: color-mix(in srgb,var(--a) 11%,var(--p));
  color: var(--a);
}
.download-dialog {
  top: 44px;
  left: calc((820px - 500px)/2);
  width: 500px;
}
.download-fields {
  display: grid;
  gap: 14px;
  padding: 17px;
}
.download-fields label {
  display: grid;
  gap: 6px;
  font-size: 11px;
}
.archive-field,.exclusion-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
  min-height: 35px;
  padding: 8px 10px;
  border: 1px solid var(--l);
  border-radius: 7px;
}
.archive-field small {
  color: var(--m);
}
.exclusion-field {
  justify-content: flex-start;
  width: max-content;
  max-width: 100%;
  min-height: 27px;
  padding: 4px 8px;
  background: color-mix(in srgb,var(--a) 10%,var(--p));
  color: var(--a);
}
.organize-scene {
  position: absolute;
  inset: 0;
}
.folder-prompt {
  position: absolute;
  z-index: 3;
  top: 80px;
  left: 245px;
  display: grid;
  gap: 10px;
  width: 310px;
  padding: 16px;
  border: 1px solid var(--l);
  border-radius: 12px;
  background: var(--p);
  box-shadow: 0 15px 36px #0004;
  opacity: 0;
  animation: prompt-show 10s linear infinite;
}
.folder-prompt span {
  padding: 7px 9px;
  border: 1px solid var(--a);
  border-radius: 6px;
}
.folder-prompt b {
  justify-self: end;
  padding: 6px 11px;
  border-radius: 6px;
  background: var(--a);
  color: white;
  font-size: 11px;
}
.organize-menu {
  position: absolute;
  z-index: 3;
  top: 118px;
  left: 165px;
  display: grid;
  gap: 3px;
  width: 180px;
  padding: 7px;
  border: 1px solid var(--l);
  border-radius: 10px;
  background: var(--p);
  box-shadow: 0 10px 28px #0003;
  opacity: 0;
  animation: organize-menu-show 10s linear infinite;
}
.organize-menu > * {
  padding: 6px 7px;
  font-size: 11px;
}
.organize-menu span:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
}
.organize-menu strong {
  border-radius: 5px;
  background: color-mix(in srgb,var(--a) 12%,var(--p));
  color: var(--a);
}
.stage-organize .folder-row {
  animation: folder-show 10s linear infinite;
}
@keyframes pointer-tap {
  0%,8%,24%,100% {
    opacity: 0;
    transform: translate(6px,6px);
  }
  13%,19% {
    opacity: 1;
    transform: none;
  }
}
@keyframes entry-menu-leave {
  0%,27% {
    opacity: 1;
  }
  43%,100% {
    opacity: 0;
  }
}
@keyframes open-arrive {
  0%,32% {
    opacity: 0;
  }
  48%,100% {
    opacity: 1;
  }
}
@keyframes preview-arrive {
  0%,34% {
    opacity: 0;
  }
  46%,100% {
    opacity: 1;
  }
}
@keyframes tip-leave {
  0%,24% {
    opacity: 1;
  }
  37%,100% {
    opacity: 0;
  }
}
@keyframes dialog-arrive {
  0%,30% {
    opacity: 0;
  }
  43%,100% {
    opacity: 1;
  }
}
@keyframes prompt-show {
  0%,25%,53%,100% {
    opacity: 0;
  }
  36%,48% {
    opacity: 1;
  }
}
@keyframes folder-show {
  0%,51% {
    opacity: 0;
  }
  63%,100% {
    opacity: 1;
  }
}
@keyframes organize-menu-show {
  0%,66% {
    opacity: 0;
  }
  77%,100% {
    opacity: 1;
  }
}
@keyframes workbench-pan {
  0%,20% {
    transform: translateX(var(--x0,0px));
  }
  52%,90% {
    transform: translateX(var(--x));
  }
  100% {
    transform: translateX(var(--x0,0px));
  }
}
html:has(#docs-pause-motion:checked) .camera * {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .camera .workbench {
  transform: translateX(var(--x));
}
html:has(#docs-pause-motion:checked) .camera .entry-menu,html:has(#docs-pause-motion:checked) .camera .pointer,html:has(#docs-pause-motion:checked) .camera .action-tip,html:has(#docs-pause-motion:checked) .camera .lock-tip,html:has(#docs-pause-motion:checked) .camera .context-menu,html:has(#docs-pause-motion:checked) .camera .folder-prompt {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .camera .open-shade,html:has(#docs-pause-motion:checked) .camera .open-dialog,html:has(#docs-pause-motion:checked) .camera .preview-text,html:has(#docs-pause-motion:checked) .camera .overlay-shade,html:has(#docs-pause-motion:checked) .camera .zip-dialog,html:has(#docs-pause-motion:checked) .camera .download-dialog,html:has(#docs-pause-motion:checked) .camera .organize-menu,html:has(#docs-pause-motion:checked) .camera.stage-organize .folder-row {
  opacity: 1;
}
@media(prefers-reduced-motion:reduce) {
  .camera * {
    animation: none!important;
  }
  .camera .workbench {
    transform: translateX(var(--x));
  }
  .entry-menu,.pointer,.action-tip,.lock-tip,.context-menu,.folder-prompt {
    opacity: 0;
  }
  .open-shade,.open-dialog,.preview-text,.overlay-shade,.zip-dialog,.download-dialog,.organize-menu,.stage-organize .folder-row {
    opacity: 1;
  }
}
@media(max-width:650px) {
  .stage-browse .workbench {
    --x:-490px;
  }
  .stage-upload .workbench {
    --x0:-350px;
    --x:-260px;
  }
  .stage-download .workbench {
    --x:-260px;
  }
  .stage-organize .workbench {
    --x0:-310px;
    --x:-150px;
  }
  .entry-sidebar {
    width: 135px;
  }
  .entry-menu {
    left: 94px;
  }
  .open-dialog {
    left: 4%;
    width: 92%;
  }
  .zip-dialog {
    left: calc((820px - 520px)/2);
    width: 520px;
  }
  .zip-grid {
    grid-template-columns: 245px 1fr;
  }
  .download-dialog {
    left: calc((820px - 420px)/2);
    width: 420px;
  }
}
@media(max-width:430px) {
  .camera {
    height: 336px;
  }
  .stage-upload .workbench {
    --x:-240px;
  }
  .stage-download .workbench {
    --x:-260px;
  }
  .stage-organize .workbench {
    --x:-140px;
  }
  .zip-dialog {
    top: 8px;
    left: calc((820px - 330px)/2);
    width: 330px;
  }
  .zip-dialog header {
    padding: 8px 10px;
  }
  .zip-grid {
    display: block;
    min-height: 0;
  }
  .zip-choices {
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 7px;
    border-right: 0;
    border-bottom: 1px solid var(--l);
    font-size: 10px;
  }
  .zip-choices .archive-name,.zip-choices small {
    grid-column: 1/-1;
  }
  .zip-choices .archive-name {
    margin: 0;
    padding: 4px;
  }
  .zip-choices .option,.zip-choices .root-choice {
    padding: 4px 6px;
  }
  .zip-preview {
    padding: 7px 9px;
    font-size: 10px;
  }
  .zip-preview > small {
    margin: 2px 0 4px;
  }
  .preview-row {
    padding: 4px 2px;
  }
  .zip-dialog footer {
    padding: 5px 9px;
  }
  .zip-dialog footer span {
    padding: 5px 8px;
  }
  .download-dialog {
    top: 35px;
    left: calc((820px - 315px)/2);
    width: 315px;
  }
  .download-fields {
    padding: 10px;
  }
  .folder-prompt {
    left: 190px;
    width: 295px;
  }
  .organize-menu {
    left: 210px;
  }
}
.camera {
  container-type: inline-size;
}
.stage-upload .workbench,.stage-download .workbench {
  --x:calc((100cqw - 820px)/2);
}
.zip-dialog,.download-dialog {
  left: 50%;
  transform: translateX(-50%);
  width: min(610px,calc(100cqw - 20px));
}
.download-dialog {
  width: min(500px,calc(100cqw - 20px));
}
@media(max-width:650px) {
  .zip-dialog {
    width: min(520px,calc(100cqw - 20px));
  }
  .download-dialog {
    width: min(420px,calc(100cqw - 20px));
  }
}
@media(max-width:430px) {
  .zip-dialog {
    width: min(330px,calc(100cqw - 20px));
  }
  .download-dialog {
    width: min(315px,calc(100cqw - 20px));
  }
}
.stage-organize .lock-icon {
  position: relative;
}
.stage-organize .lock-icon > svg:first-child {
  animation: locked-leave 10s linear infinite;
}
.stage-organize .lock-icon .organize-unlocked {
  position: absolute;
  inset: 0;
  opacity: 0;
  color: var(--m);
  animation: unlocked-arrive 10s linear infinite;
}
.stage-organize .folder-prompt {
  animation: folder-prompt-show 10s linear infinite;
}
.stage-organize .folder-row {
  animation: created-folder-show 10s linear infinite;
}
.stage-organize .organize-menu {
  animation: paste-menu-show 10s linear infinite;
}
.stage-organize .status-bar > span:first-child {
  display: grid;
}
.stage-organize .status-bar .before-count,.stage-organize .status-bar .after-count {
  grid-area: 1/1;
}
.stage-organize .status-bar .before-count {
  animation: old-count-leave 10s linear infinite;
}
.stage-organize .status-bar .after-count {
  opacity: 0;
  animation: new-count-show 10s linear infinite;
}
@keyframes locked-leave {
  0%,20% {
    opacity: 1;
  }
  32%,100% {
    opacity: 0;
  }
}
@keyframes unlocked-arrive {
  0%,20% {
    opacity: 0;
  }
  32%,100% {
    opacity: 1;
  }
}
@keyframes folder-prompt-show {
  0%,45%,67%,100% {
    opacity: 0;
  }
  53%,62% {
    opacity: 1;
  }
}
@keyframes created-folder-show {
  0%,62% {
    opacity: 0;
  }
  72%,100% {
    opacity: 1;
  }
}
@keyframes paste-menu-show {
  0%,76% {
    opacity: 0;
  }
  84%,100% {
    opacity: 1;
  }
}
@keyframes old-count-leave {
  0%,62% {
    opacity: 1;
  }
  72%,100% {
    opacity: 0;
  }
}
@keyframes new-count-show {
  0%,62% {
    opacity: 0;
  }
  72%,100% {
    opacity: 1;
  }
}
html:has(#docs-pause-motion:checked) .camera.stage-organize .lock-icon > svg:first-child {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .camera.stage-organize .lock-icon .organize-unlocked {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .camera.stage-organize .status-bar .before-count {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .camera.stage-organize .status-bar .after-count {
  opacity: 1;
}
@media(prefers-reduced-motion:reduce) {
  .stage-organize .lock-icon > svg:first-child {
    opacity: 0;
  }
  .stage-organize .lock-icon .organize-unlocked {
    opacity: 1;
  }
  .stage-organize .status-bar .before-count {
    opacity: 0;
  }
  .stage-organize .status-bar .after-count {
    opacity: 1;
  }
}
@media(max-width:650px) {
  .stage-organize .workbench {
    --x:0px;
  }
}
@media(max-width:430px) {
  .organize-menu {
    left: 120px;
  }
}
@container (max-width:650px) {
  .stage-browse .workbench {
    --x:calc(50cqw - 684px);
  }
  .stage-upload .workbench {
    --x0:-350px;
  }
  .stage-organize .workbench {
    --x0:-310px;
    --x:0px;
  }
  .zip-grid {
    grid-template-columns: 245px 1fr;
  }
}
@container (max-width:430px) {
  .zip-grid {
    display: block;
    min-height: 0;
  }
  .zip-choices {
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 7px;
    border-right: 0;
    border-bottom: 1px solid var(--l);
    font-size: 10px;
  }
  .zip-choices .archive-name,.zip-choices small {
    grid-column: 1/-1;
  }
  .zip-choices .archive-name {
    margin: 0;
    padding: 4px;
  }
  .zip-choices .option,.zip-choices .root-choice {
    padding: 4px 6px;
  }
  .zip-preview {
    padding: 7px 9px;
    font-size: 10px;
  }
  .zip-preview > small {
    margin: 2px 0 4px;
  }
  .preview-row {
    padding: 4px 2px;
  }
  .zip-dialog footer {
    padding: 5px 9px;
  }
  .zip-dialog footer span {
    padding: 5px 8px;
  }
  .download-fields {
    padding: 10px;
  }
  .folder-prompt {
    left: 8px;
    width: calc(100cqw - 16px);
    padding: 12px;
  }
  .organize-menu {
    left: 95px;
  }
}
</style>
