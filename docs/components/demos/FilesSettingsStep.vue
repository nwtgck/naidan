<script setup lang="ts">
import {
  DatabaseIcon, DownloadIcon, FileIcon, FolderDownIcon, FolderIcon, FolderPlusIcon,
  GlobeIcon, HardDriveIcon, InfoIcon, LayoutGridIcon, ListIcon, LockIcon, MousePointer2Icon,
  RefreshCwIcon, SearchIcon, Settings2Icon, SettingsIcon, Trash2Icon, WrenchIcon,
  XIcon,
} from 'lucide-vue-next';

defineProps<{
  stage: 'open' | 'files' | 'choose' | 'copy' | 'manage',
  messages: typeof import('../../pages/files-and-folders-settings/messages/en').messages,
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="settings-camera" :class="`stage-${stage}`" :data-docs-animation="`files-settings-${stage}`" :data-testid="`files-settings-step-${stage}`" aria-hidden="true">
    <div class="camera-canvas">
      <aside class="app-sidebar">
        <strong>Naidan</strong>
        <span class="chat-placeholder" /><span class="chat-placeholder short" />
        <div class="app-settings"><SettingsIcon :size="17" />{{ messages.settings_label }}<MousePointer2Icon v-if="stage === 'open'" class="pointer app-pointer" :size="24" /></div>
      </aside>
      <div class="app-background"><span /><span /></div>

      <div class="settings-modal">
        <aside class="modal-sidebar">
          <div class="modal-heading"><span class="heading-icon"><Settings2Icon :size="19" /></span><strong>{{ messages.settings_label }}</strong></div>
          <nav class="modal-nav">
            <div><GlobeIcon :size="17" />{{ messages.connection_settings }}</div>
            <div><WrenchIcon :size="17" />{{ messages.tools_settings }}</div>
            <div><DatabaseIcon :size="17" />{{ messages.storage_settings }}</div>
            <div class="files-tab" :class="{ active: stage === 'open' || stage === 'files' }"><FileIcon :size="17" />{{ messages.files_screen }}<MousePointer2Icon v-if="stage === 'open'" class="pointer nav-pointer" :size="23" /></div>
            <div class="folders-tab" :class="{ active: stage === 'choose' || stage === 'copy' || stage === 'manage' }"><FolderIcon :size="17" />{{ messages.folders_screen }}</div>
          </nav>
        </aside>
        <main class="modal-main">
          <span class="modal-close"><XIcon :size="18" /></span>
          <section v-if="stage === 'open' || stage === 'files'" class="files-content">
            <div class="content-heading"><span class="content-icon"><HardDriveIcon :size="19" /></span><div><strong>{{ messages.saved_files_heading }}</strong><small>{{ messages.saved_files_help }}</small></div><span class="count">1 / 1</span><span class="heading-spacer" /><LayoutGridIcon :size="16" /><ListIcon :size="16" /><RefreshCwIcon :size="15" /></div>
            <div class="search-field"><SearchIcon :size="17" /><span class="search-placeholder">{{ messages.search_saved_files }}</span><strong class="search-query">project</strong></div>
            <div class="file-table">
              <div class="table-head"><span>{{ messages.name_column }}</span><span>{{ messages.size_column }}</span><span>{{ messages.date_column }}</span><span /></div>
              <div class="file-row"><span class="file-identity"><span class="file-icon"><FileIcon :size="19" /></span><span><strong>{{ messages.example_filename }}</strong><small>{{ messages.example_file_type }}</small></span></span><span>{{ messages.example_file_size }}</span><span>{{ messages.example_file_date }}</span><span class="file-actions"><DownloadIcon :size="17" /><Trash2Icon :size="17" /><MousePointer2Icon v-if="stage === 'files'" class="pointer file-pointer" :size="23" /></span></div>
            </div>
          </section>

          <section v-else class="folders-content">
            <div class="folder-heading"><FolderIcon :size="20" /><span><strong>{{ messages.working_folders_heading }}</strong><small>{{ messages.working_folders_help }}</small></span></div>
            <div class="folder-actions"><span class="add-folder"><FolderPlusIcon :size="16" />{{ messages.add_folder_action }}<MousePointer2Icon v-if="stage === 'choose'" class="pointer add-pointer" :size="23" /></span><span class="copy-folder"><FolderDownIcon :size="16" />{{ messages.copy_folder_action }}<InfoIcon :size="14" /><MousePointer2Icon v-if="stage === 'copy'" class="pointer copy-pointer" :size="23" /></span></div>
            <div v-if="stage === 'choose'" class="access-panel"><small>{{ messages.choose_access_label }}</small><div class="read-choice"><LockIcon :size="17" /><strong>{{ messages.read_only }}</strong></div><div>{{ messages.read_write }}</div></div>
            <div v-if="stage === 'copy'" class="copy-progress"><strong>{{ messages.copy_folder_action }}</strong><span class="progress-bar"><i /></span></div>
            <div v-if="stage === 'copy' || stage === 'manage'" class="folder-list"><small>{{ messages.in_use_globally }}</small><div class="mount-card"><span class="folder-badge"><FolderDownIcon :size="21" /></span><span class="mount-detail"><strong>{{ messages.example_folder_name }}</strong><span><code>{{ messages.example_mount_path }}</code><em><LockIcon :size="10" />{{ messages.read_only }}</em><small>{{ messages.copied_status }}</small></span></span><span class="mount-config"><Settings2Icon :size="17" /><MousePointer2Icon v-if="stage === 'manage'" class="pointer config-pointer" :size="23" /></span></div></div>
            <div v-if="stage === 'manage'" class="mount-editor"><div class="editor-fields"><label><small>{{ messages.path_label }}</small><span>{{ messages.example_mount_path }}</span></label><label><small>{{ messages.access_mode }}</small><span class="read-mode"><LockIcon :size="13" />{{ messages.read_only }}</span></label></div><div class="editor-footer"><span class="save-button">{{ messages.save_changes_action }}</span></div></div>
          </section>
        </main>
      </div>
    </div>
    <div v-if="stage === 'files'" class="files-focus">
      <small class="focus-note">{{ messages.saved_file_focus_note }}</small>
      <span class="focus-query"><SearchIcon :size="13" />project</span>
      <span class="focus-result"><FileIcon :size="15" /><strong>{{ messages.example_filename }}</strong><span><DownloadIcon :size="15" />{{ messages.download_action }}</span></span>
    </div>
  </div>
</template>

<style scoped>
.settings-camera {
  --c-panel:var(--surface);
  --c-field:var(--surface-2);
  --c-line:var(--line-strong);
  --c-blue:var(--blue);
  container-type: inline-size;
  position: relative;
  width: 100%;
  max-width: 680px;
  height: 340px;
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid var(--c-line);
  border-radius: 15px;
  background: var(--bg);
  box-shadow: var(--panel-shadow);
  color: var(--text);
  font: 13px/1.45 ui-sans-serif,system-ui,sans-serif;
}
.settings-camera * {
  box-sizing: border-box;
}
.camera-canvas {
  position: absolute;
  left: 0;
  top: 0;
  width: 1050px;
  height: 710px;
  transform-origin: top left;
}
.stage-open .camera-canvas {
  transform: translate(-133px,-10px) scale(.94);
  animation: camera-open 10s ease-in-out infinite;
}
.stage-files .camera-canvas {
  transform: translate(-330px,-90px) scale(.94);
  animation: camera-files 9s ease-in-out infinite;
}
.stage-choose .camera-canvas,.stage-copy .camera-canvas {
  transform: translate(-330px,-90px) scale(.94);
  animation: camera-content 9s ease-in-out infinite;
}
.stage-manage .camera-canvas {
  transform: translate(-330px,-163px) scale(.94);
  animation: camera-manage 9s ease-in-out infinite;
}
.app-sidebar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 170px;
  padding: 23px 15px;
  background: var(--c-panel);
  border-right: 1px solid var(--c-line);
  display: flex;
  flex-direction: column;
}
.app-sidebar > strong {
  font-size: 20px;
  letter-spacing: -.04em;
}
.chat-placeholder {
  height: 30px;
  margin-top: 23px;
  border-radius: 9px;
  background: var(--c-field);
}
.chat-placeholder.short {
  width: 75%;
  margin-top: 10px;
}
.app-settings {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding: 12px;
  border: 1px solid var(--c-line);
  border-radius: 11px;
  color: var(--muted);
  font-weight: 700;
}
.app-background {
  position: absolute;
  inset: 0 0 0 170px;
  background: var(--c-field);
}
.app-background span:first-child {
  display: block;
  height: 56px;
  background: var(--c-panel);
  border-bottom: 1px solid var(--c-line);
}
.app-background span:last-child {
  display: block;
  width: 280px;
  height: 150px;
  margin: 210px auto;
  border: 1px dashed var(--c-line);
  border-radius: 16px;
}
.settings-modal {
  position: absolute;
  left: 145px;
  top: 28px;
  width: 884px;
  height: 640px;
  display: grid;
  grid-template-columns: 214px minmax(0,1fr);
  overflow: hidden;
  border: 1px solid var(--c-line);
  border-radius: 22px;
  background: var(--c-panel);
  box-shadow: 0 24px 70px #0006;
}
.stage-open .settings-modal {
  animation: modal-enter 10s ease-in-out infinite;
}
.modal-sidebar {
  background: var(--c-field);
  border-right: 1px solid var(--c-line);
}
.modal-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 71px;
  padding: 15px;
  border-bottom: 1px solid var(--c-line);
  font-size: 17px;
}
.heading-icon,.content-icon {
  display: grid;
  place-items: center;
  width: 35px;
  height: 35px;
  flex: none;
  border: 1px solid var(--c-line);
  border-radius: 10px;
  background: var(--c-panel);
  color: var(--c-blue);
}
.modal-nav {
  display: grid;
  align-content: start;
  gap: 5px;
  padding: 14px 11px;
}
.modal-nav > div {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 43px;
  padding: 10px 13px;
  border: 1px solid transparent;
  border-radius: 11px;
  color: var(--muted);
  font-weight: 750;
}
.modal-nav > .active {
  color: var(--c-blue);
  background: var(--c-panel);
  border-color: var(--c-line);
  box-shadow: 0 5px 14px #0001;
}
.modal-main {
  position: relative;
  min-width: 0;
  overflow: hidden;
  padding: 40px 28px;
  background: var(--c-panel);
}
.modal-close {
  position: absolute;
  right: 17px;
  top: 16px;
  color: var(--muted);
}
.files-content,.folders-content {
  width: 100%;
  max-width: 610px;
}
.content-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--c-line);
}
.content-heading > div:nth-child(2) {
  display: grid;
  gap: 2px;
}
.content-heading strong,.folder-heading strong {
  font-size: 17px;
}
.content-heading small,.folder-heading small {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.count {
  padding: 3px 8px;
  border-radius: 10px;
  background: var(--c-field);
  color: var(--muted);
  font-size: 10px;
  font-weight: 750;
}
.heading-spacer {
  flex: 1;
}
.content-heading > svg {
  color: var(--muted);
}
.search-field {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 43px;
  margin: 20px 0 16px;
  padding: 0 14px;
  border: 1px solid var(--c-line);
  border-radius: 13px;
  background: var(--c-field);
  color: var(--muted);
}
.search-placeholder {
  opacity: 0;
}
.search-query {
  position: absolute;
  margin-left: 29px;
  color: var(--text);
}
.stage-open .search-placeholder {
  opacity: 1;
}
.stage-open .search-query {
  opacity: 0;
}
.stage-files .search-placeholder {
  animation: search-before 9s linear infinite;
}
.stage-files .search-query {
  animation: search-after 9s linear infinite;
}
.file-table {
  overflow: hidden;
  border: 1px solid var(--c-line);
  border-radius: 16px;
}
.table-head,.file-row {
  display: grid;
  grid-template-columns: minmax(0,2fr) 73px 92px 62px;
  align-items: center;
  gap: 9px;
  padding: 12px;
}
.table-head {
  background: var(--c-field);
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
}
.file-row {
  min-height: 66px;
  font-size: 11px;
  color: var(--muted);
}
.file-identity {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.file-identity > span:last-child {
  min-width: 0;
}
.file-identity strong,.file-identity small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-identity strong {
  color: var(--text);
  font-size: 12px;
}
.file-identity small {
  font-size: 10px;
}
.file-icon {
  display: grid;
  place-items: center;
  width: 35px;
  height: 35px;
  flex: none;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: var(--c-field);
}
.file-actions {
  position: relative;
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  color: var(--c-blue);
}
.folder-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--c-line);
}
.folder-heading > svg {
  color: var(--c-blue);
}
.folder-heading > span {
  display: grid;
  gap: 2px;
}
.folder-actions {
  display: flex;
  gap: 9px;
  margin-top: 16px;
}
.folder-actions > span {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 13px;
  border: 1px solid var(--c-line);
  border-radius: 11px;
  background: var(--c-panel);
  font-size: 12px;
  font-weight: 750;
}
.folder-actions > .add-folder {
  color: white;
  background: #2563eb;
  border-color: #2563eb;
}
.access-panel {
  position: absolute;
  z-index: 2;
  top: 155px;
  left: 28px;
  width: 260px;
  overflow: hidden;
  border: 1px solid var(--c-line);
  border-radius: 15px;
  background: var(--c-panel);
  box-shadow: 0 10px 25px #0003;
}
.access-panel > small {
  display: block;
  padding: 11px 14px 3px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
}
.access-panel > div {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 15px;
  border-top: 1px solid var(--c-line);
  font-weight: 700;
}
.access-panel .read-choice {
  color: var(--c-blue);
}
.stage-choose .access-panel {
  animation: panel-appear 9s linear infinite;
}
.copy-progress {
  position: absolute;
  left: 28px;
  top: 155px;
  width: 355px;
  padding: 15px;
  border: 1px solid var(--c-line);
  border-radius: 14px;
  background: var(--c-field);
  opacity: 0;
}
.progress-bar {
  display: block;
  height: 6px;
  margin-top: 13px;
  border-radius: 5px;
  background: var(--c-line);
  overflow: hidden;
}
.progress-bar i {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--c-blue);
}
.stage-copy .copy-progress {
  animation: copy-progress 9s linear infinite;
}
.stage-copy .copy-progress i {
  animation: progress-fill 9s linear infinite;
  transform-origin: left;
}
.folder-list {
  margin-top: 38px;
  max-width: 440px;
}
.folder-list > small {
  display: block;
  margin-bottom: 12px;
  color: var(--c-blue);
  font-size: 10px;
  font-weight: 850;
  letter-spacing: .07em;
}
.mount-card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 76px;
  padding: 13px;
  border: 1px solid color-mix(in srgb,var(--c-blue) 24%,var(--c-line));
  border-radius: 14px;
  background: var(--c-panel);
}
.folder-badge {
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  flex: none;
  border-radius: 10px;
  background: color-mix(in srgb,var(--c-blue) 11%,var(--c-field));
  color: var(--c-blue);
}
.mount-detail {
  display: grid;
  gap: 5px;
  min-width: 0;
  flex: 1;
}
.mount-detail > strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.mount-detail > span {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.mount-detail code {
  padding: 3px 6px;
  border-radius: 5px;
  background: color-mix(in srgb,var(--c-blue) 10%,var(--c-field));
  color: var(--c-blue);
  font-size: 10px;
  font-weight: 750;
}
.mount-detail em {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border-radius: 5px;
  background: color-mix(in srgb,var(--green) 11%,var(--c-field));
  color: var(--green);
  font-size: 9px;
  font-style: normal;
  font-weight: 750;
}
.mount-detail small {
  color: var(--muted);
  font-size: 10px;
}
.mount-config {
  position: relative;
  color: var(--muted);
}
.stage-copy .folder-list {
  animation: copy-result 9s linear infinite;
}
.mount-editor {
  width: 440px;
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--c-line);
  border-radius: 13px;
  background: var(--c-field);
}
.editor-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px;
}
.editor-fields label {
  display: grid;
  gap: 5px;
}
.editor-fields small {
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
}
.editor-fields label > span {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 9px;
  border: 1px solid var(--c-line);
  border-radius: 7px;
  background: var(--c-panel);
  font-size: 11px;
  font-weight: 700;
}
.editor-fields .read-mode {
  color: var(--c-blue);
}
.editor-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.save-button {
  padding: 8px 12px;
  border-radius: 7px;
  background: #2563eb;
  color: white;
  font-size: 10px;
  font-weight: 800;
}
.stage-manage .mount-editor {
  animation: panel-appear 9s linear infinite;
}
.pointer {
  position: absolute;
  z-index: 4;
  fill: var(--c-panel);
  filter: drop-shadow(0 2px 3px #0008);
}
.app-pointer {
  right: 7px;
  bottom: -10px;
  animation: pointer-tap 10s linear infinite;
}
.nav-pointer {
  right: 8px;
  bottom: -10px;
  animation: nav-tap 10s linear infinite;
}
.add-pointer,.copy-pointer {
  right: 1px;
  bottom: -10px;
  animation: action-tap 9s linear infinite;
}
.config-pointer {
  right: -10px;
  bottom: -12px;
  animation: action-tap 9s linear infinite;
}
.file-pointer {
  right: 27px;
  bottom: -15px;
  animation: file-action-tap 9s linear infinite;
}
@keyframes camera-open {
  0%,24% {
    transform: translate(10px,-303px) scale(.9);
  }
  48%,92% {
    transform: translate(-133px,-10px) scale(.94);
  }
  100% {
    transform: translate(10px,-303px) scale(.9);
  }
}
@keyframes camera-content {
  0%,8% {
    transform: translate(-139px,-28px) scale(.92);
  }
  21%,92% {
    transform: translate(-330px,-90px) scale(.94);
  }
  100% {
    transform: translate(-139px,-28px) scale(.92);
  }
}
@keyframes camera-files {
  0%,8% {
    transform: translate(-133px,-10px) scale(.94);
  }
  21%,92% {
    transform: translate(-330px,-90px) scale(.94);
  }
  100% {
    transform: translate(-133px,-10px) scale(.94);
  }
}
@keyframes camera-manage {
  0%,8% {
    transform: translate(-139px,-92px) scale(.92);
  }
  21%,92% {
    transform: translate(-330px,-163px) scale(.94);
  }
  100% {
    transform: translate(-139px,-92px) scale(.92);
  }
}
@keyframes modal-enter {
  0%,22% {
    opacity: 0;
    transform: translateY(14px) scale(.97);
  }
  40%,94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes search-before {
  0%,30% {
    opacity: 1;
  }
  40%,100% {
    opacity: 0;
  }
}
@keyframes search-after {
  0%,30% {
    opacity: 0;
  }
  42%,100% {
    opacity: 1;
  }
}
@keyframes panel-appear {
  0%,27% {
    opacity: 0;
    transform: translateY(-7px);
  }
  41%,92% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes copy-progress {
  0%,20% {
    opacity: 0;
  }
  30%,58% {
    opacity: 1;
  }
  68%,100% {
    opacity: 0;
  }
}
@keyframes progress-fill {
  0%,24% {
    transform: scaleX(.03);
  }
  63%,100% {
    transform: scaleX(1);
  }
}
@keyframes copy-result {
  0%,60% {
    opacity: 0;
    transform: translateY(7px);
  }
  72%,94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes pointer-tap {
  0%,8%,34%,100% {
    opacity: 0;
  }
  13%,24% {
    opacity: 1;
  }
}
@keyframes nav-tap {
  0%,44%,67%,100% {
    opacity: 0;
  }
  49%,59% {
    opacity: 1;
  }
}
@keyframes action-tap {
  0%,11%,36%,100% {
    opacity: 0;
  }
  16%,28% {
    opacity: 1;
  }
}
@keyframes file-action-tap {
  0%,57%,76%,100% {
    opacity: 0;
  }
  62%,70% {
    opacity: 1;
  }
}
@media(max-width:610px) {
  .settings-camera {
    height: 315px;
  }
  .stage-open .camera-canvas {
    transform: translate(-139px,-7px) scale(.88);
    animation-name: camera-open-narrow;
  }
  .stage-files .camera-canvas {
    transform: translate(-586px,-75px) scale(.87);
    animation-name: camera-files-narrow;
  }
  .stage-choose .camera-canvas,.stage-copy .camera-canvas {
    transform: translate(-329px,-75px) scale(.87);
    animation-name: camera-content-narrow;
  }
  .stage-manage .camera-canvas {
    transform: translate(-329px,-150px) scale(.87);
    animation-name: camera-manage-narrow;
  }
  .folder-list,.mount-editor,.copy-progress {
    width: 300px;
    max-width: 300px;
  }
  .mount-detail small {
    display: none;
  }
  .editor-fields {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .editor-fields label > span {
    min-height: 28px;
  }
}
.files-focus {
  display: none;
}
@media(max-width:610px) {
  .stage-files .files-focus {
    position: absolute;
    right: 8px;
    bottom: 8px;
    left: 8px;
    display: grid;
    gap: 4px;
    min-height: 78px;
    padding: 8px 10px;
    border: 1px dashed var(--c-blue);
    border-radius: 10px;
    background: var(--c-panel);
    box-shadow: 0 5px 14px #0002;
    animation: files-focus-in 9s linear infinite;
  }
  .focus-note {
    color: var(--muted);
    font-size: 9px;
  }
  .focus-query,.focus-result,.focus-result > span {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .focus-query {
    color: var(--muted);
    font-size: 10px;
  }
  .focus-result {
    min-width: 0;
    color: var(--text);
    font-size: 11px;
  }
  .focus-result > strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .focus-result > span {
    margin-left: auto;
    color: var(--c-blue);
    font-size: 10px;
    font-weight: 750;
    white-space: nowrap;
  }
}
@keyframes files-focus-in {
  0%,60% {
    opacity: 0;
  }
  72%,94% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes camera-open-narrow {
  0%,24% {
    transform: translate(8px,-316px) scale(.86);
  }
  48%,92% {
    transform: translate(-139px,-7px) scale(.88);
  }
  100% {
    transform: translate(8px,-316px) scale(.86);
  }
}
@keyframes camera-content-narrow {
  0%,8% {
    transform: translate(-155px,-20px) scale(.87);
  }
  21%,92% {
    transform: translate(-329px,-75px) scale(.87);
  }
  100% {
    transform: translate(-155px,-20px) scale(.87);
  }
}
@keyframes camera-files-narrow {
  0%,8% {
    transform: translate(-139px,-7px) scale(.88);
  }
  21%,52% {
    transform: translate(-329px,-75px) scale(.87);
  }
  65%,92% {
    transform: translate(-586px,-75px) scale(.87);
  }
  100% {
    transform: translate(-139px,-7px) scale(.88);
  }
}
@keyframes camera-manage-narrow {
  0%,8% {
    transform: translate(-155px,-80px) scale(.87);
  }
  21%,92% {
    transform: translate(-329px,-150px) scale(.87);
  }
  100% {
    transform: translate(-155px,-80px) scale(.87);
  }
}
html:has(#docs-pause-motion:checked) .settings-camera *, html:has(#docs-pause-motion:checked) .settings-camera *::before, html:has(#docs-pause-motion:checked) .settings-camera *::after {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .settings-camera .pointer {
  display: none;
}
@media(prefers-reduced-motion:reduce) {
  .settings-camera *, .settings-camera *::before, .settings-camera *::after {
    animation: none!important;
  }
  .pointer {
    display: none;
  }
}
</style>
