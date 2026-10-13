<script setup lang="ts">
import { CheckIcon, CopyPlusIcon, DatabaseIcon, DownloadIcon, FileArchiveIcon, FolderInputIcon, HardDriveIcon, MousePointer2Icon, RefreshCwIcon, Settings2Icon, ShieldCheckIcon, UploadIcon, XIcon } from 'lucide-vue-next';
import type { BackupGuideMessages } from '../messages';

defineProps<{ stage: 'export' | 'preview' | 'mode'; copy: BackupGuideMessages['demo'] }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="backup-viewport" :class="`stage-${stage}`" :data-docs-animation="`backup-${stage}`" :data-testid="`backup-step-${stage}`" aria-hidden="true">
    <div class="camera">
      <div class="app-canvas">
        <aside class="app-sidebar"><strong>Naidan</strong><div class="app-chat-line" /><div class="app-chat-line short" /><div class="app-sidebar-bottom"><Settings2Icon :size="18" />{{ copy.settings }}</div></aside>
        <div class="app-background" />
        <div class="settings-window">
          <aside class="settings-sidebar">
            <div class="settings-heading"><span><Settings2Icon :size="19" /></span><strong>{{ copy.settings }}</strong><small>{{ copy.language }}</small></div>
            <nav class="settings-nav"><div>{{ copy.connection }}</div><div>{{ copy.tools }}</div><div>{{ copy.models }}</div><div class="storage-nav"><DatabaseIcon :size="17" />{{ copy.storage }}</div><div>{{ copy.filesTab }}</div><div>{{ copy.about }}</div></nav>
            <div class="settings-footer">{{ copy.settings }}</div>
          </aside>
          <main class="settings-main">
            <div class="settings-content">
              <section class="durability-section"><h3><ShieldCheckIcon :size="19" />{{ copy.dataDurability }}</h3><div class="context-card"><ShieldCheckIcon :size="20" /><span>{{ copy.dataDurability }}</span></div></section>
              <section class="backup-section"><h3><FileArchiveIcon :size="19" />{{ copy.backupAndRestore }}</h3><div class="backup-card"><FileArchiveIcon :size="24" /><span><strong>{{ copy.exportImport }}</strong><small>{{ copy.experimental }}</small></span><span class="manage-data">{{ copy.manageData }}<MousePointer2Icon v-if="stage === 'export'" class="pointer manage-pointer" :size="23" /></span></div></section>
              <section class="storage-section"><h3><DatabaseIcon :size="19" />{{ copy.storageManagement }}</h3><div class="context-card"><HardDriveIcon :size="20" /><span>{{ copy.storageManagement }}</span></div></section>
            </div>
          </main>
          <div class="settings-close"><XIcon :size="18" /></div>
        </div>

        <div class="import-window">
          <header class="import-heading"><span class="import-icon"><FolderInputIcon :size="25" /></span><span><strong>{{ copy.exportImport }}</strong><em>{{ copy.experimental }}</em></span><XIcon :size="20" /></header>
          <div class="import-content">
            <div v-if="stage !== 'mode'" class="menu-pane"><div class="menu-card export-menu"><UploadIcon :size="28" /><strong>{{ copy.export }}</strong><MousePointer2Icon v-if="stage === 'export'" class="pointer menu-pointer" :size="23" /></div><div class="menu-card import-menu"><DownloadIcon :size="28" /><strong>{{ copy.import }}</strong><MousePointer2Icon v-if="stage === 'preview'" class="pointer menu-pointer" :size="23" /></div></div>

            <div v-if="stage === 'export'" class="export-pane">
              <div class="pane-heading"><UploadIcon :size="21" /><strong>{{ copy.readyToExport }}</strong></div>
              <label class="filename-tag">{{ copy.filenameTag }}<span class="input-look" /></label>
              <div class="exclusions"><div class="check-item"><span class="fake-check" />{{ copy.excludeChats }}</div><div class="check-item history-choice"><span class="fake-check"><CheckIcon :size="13" /></span>{{ copy.excludeHistory }}<MousePointer2Icon class="pointer history-pointer" :size="23" /></div><div class="check-item"><span class="fake-check" />{{ copy.excludeAttachments }}</div></div>
              <div class="filename-preview"><small>{{ copy.outputFilename }}</small><strong>{{ copy.filename }}</strong></div>
              <div class="action-row"><span class="success-message"><CheckIcon :size="18" />{{ copy.savedCopy }}</span><span class="primary-action"><UploadIcon :size="17" />{{ copy.exportNow }}<MousePointer2Icon class="pointer export-pointer" :size="23" /></span></div>
            </div>

            <div v-if="stage === 'preview' || stage === 'mode'" class="preview-pane">
              <div class="pane-heading"><DownloadIcon :size="21" /><strong>{{ copy.import }}</strong></div>
              <div class="upload-row"><span class="upload-action"><FileArchiveIcon :size="17" />{{ copy.chooseZip }}<MousePointer2Icon v-if="stage === 'preview'" class="pointer upload-pointer" :size="23" /></span><strong>{{ copy.chosenZip }}</strong></div>
              <div class="stats-grid"><div><strong>1</strong><small>{{ copy.groups }}</small></div><div><strong>2</strong><small>{{ copy.chats }}</small></div><div><strong>1</strong><small>{{ copy.files }}</small></div><div><strong>1</strong><small>{{ copy.profiles }}</small></div></div>
              <div class="content-preview"><strong>{{ copy.contentPreview }}</strong><span><FolderInputIcon :size="17" />{{ copy.sampleGroup }}</span><span class="chat-row">• {{ copy.sampleChat }}</span></div>
              <div class="action-row"><span class="primary-action">{{ copy.next }}<MousePointer2Icon v-if="stage === 'mode'" class="pointer next-pointer" :size="23" /></span></div>
            </div>

            <div v-if="stage === 'mode'" class="mode-pane">
              <div class="archive-summary"><FileArchiveIcon :size="17" /><strong>{{ copy.chosenZip }}</strong><span>1 {{ copy.groups }} · 2 {{ copy.chats }} · 1 {{ copy.files }}</span></div>
              <div class="mode-grid"><div class="mode-card append-card"><CopyPlusIcon :size="19" /><span><strong>{{ copy.append }}</strong><small>{{ copy.appendHelp }}</small></span><span class="radio-mark"><CheckIcon :size="13" /></span><MousePointer2Icon class="pointer append-pointer" :size="23" /></div><div class="mode-card"><RefreshCwIcon :size="19" /><span><strong>{{ copy.replace }}</strong><small>{{ copy.replaceHelp }}</small></span><span class="radio-mark" /></div></div>
              <p class="replace-warning">{{ copy.replaceWarning }}</p>
              <div class="settings-fields"><strong>{{ copy.settingsAndProfiles }}</strong><div><span>{{ copy.urlAndHeaders }}</span><em>{{ copy.keepCurrent }}</em></div><div><span>{{ copy.profiles }}</span><em>{{ copy.addNew }}</em></div></div>
              <div class="action-row"><span class="import-progress"><span class="verify">{{ copy.verify }}</span><span class="import-done"><CheckIcon :size="17" />{{ copy.importDone }}</span></span><span class="primary-action"><CheckIcon :size="17" />{{ copy.importNow }}<MousePointer2Icon class="pointer import-pointer" :size="23" /></span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backup-viewport { --demo-panel:var(--surface);--demo-field:var(--surface-2);--demo-line:var(--line-strong);--demo-blue:var(--blue);--demo-warning:#fbbf24;position:relative;width:100%;max-width:680px;height:350px;margin-inline:auto;overflow:hidden;border:1px solid var(--demo-line);border-radius:15px;background:var(--bg);color:var(--text);box-shadow:var(--panel-shadow); }
:global(html:has(#docs-light-theme:checked)) .backup-viewport { --demo-warning:#92400e; }
.camera { width:1120px;height:760px;transform-origin:top left;will-change:transform; }
.stage-export .camera { transform:translate(-280px,-205px) scale(.95);animation:camera-export 11s ease-in-out infinite; }
.stage-preview .camera { transform:translate(-280px,-270px) scale(.95);animation:camera-preview 10s ease-in-out infinite; }
.stage-mode .camera { transform:translate(-310px,-235px) scale(1);animation:camera-mode 11s ease-in-out infinite; }
.app-canvas { position:relative;width:1120px;height:760px;background:var(--demo-field);font:13px/1.45 ui-sans-serif,system-ui,sans-serif; }
.app-sidebar { position:absolute;inset:0 auto 0 0;display:flex;flex-direction:column;width:154px;padding:23px 15px;background:var(--demo-panel);border-right:1px solid var(--demo-line); }
.app-sidebar > strong { margin-bottom:40px;font-size:19px;letter-spacing:-.04em; }
.app-chat-line { height:25px;margin-bottom:12px;border-radius:9px;background:var(--demo-field); }
.app-chat-line.short { width:72%; }
.app-sidebar-bottom { display:flex;align-items:center;gap:9px;margin-top:auto;padding:12px 10px;border:1px solid var(--demo-line);border-radius:11px;color:var(--muted);font-weight:750; }
.app-background { position:absolute;inset:0 0 0 154px; }
.settings-window { position:absolute;left:170px;top:36px;display:grid;grid-template-columns:220px 670px;width:890px;height:690px;border:1px solid var(--demo-line);border-radius:22px;background:var(--demo-panel);box-shadow:0 24px 70px #0005;overflow:hidden; }
.settings-sidebar { display:flex;flex-direction:column;background:var(--demo-field);border-right:1px solid var(--demo-line); }
.settings-heading { display:flex;align-items:center;gap:9px;min-height:70px;padding:15px;border-bottom:1px solid var(--demo-line); }
.settings-heading > span { display:grid;place-items:center;width:35px;height:35px;border:1px solid var(--demo-line);border-radius:10px;background:var(--demo-panel);color:var(--demo-blue); }
.settings-heading strong { font-size:17px; }
.settings-heading small { margin-left:auto;color:var(--muted);font-size:10px; }
.settings-nav { display:grid;align-content:start;gap:5px;padding:14px; }
.settings-nav > div { display:flex;align-items:center;gap:9px;min-height:42px;padding:10px 13px;border:1px solid transparent;border-radius:10px;color:var(--muted);font-weight:750; }
.settings-nav .storage-nav { border-color:var(--demo-line);background:var(--demo-panel);color:var(--demo-blue); }
.settings-footer { margin-top:auto;padding:16px;border-top:1px solid var(--demo-line);color:var(--muted);font-size:11px; }
.settings-main { min-width:0; }
.settings-content { padding:28px; }
.settings-content section { margin-bottom:28px; }
.settings-content h3 { display:flex;align-items:center;gap:9px;margin:0 0 15px;padding-bottom:12px;border-bottom:1px solid var(--demo-line);font-size:18px; }
.settings-content h3 svg { color:var(--demo-blue); }
.context-card,.backup-card { display:flex;align-items:center;gap:12px;padding:16px 18px;border:1px solid var(--demo-line);border-radius:18px;background:var(--demo-field);font-weight:750; }
.context-card svg,.backup-card > svg { color:var(--demo-blue); }
.backup-card > span:nth-child(2) { display:grid;gap:4px; }
.backup-card small { color:var(--demo-warning);font-size:10px; }
.manage-data { position:relative;margin-left:auto;padding:10px 15px;border:1px solid var(--demo-line);border-radius:10px;background:var(--demo-panel);font-size:11px;font-weight:800;white-space:nowrap; }
.stage-export .manage-data { animation:manage-highlight 11s linear infinite; }
.settings-close { position:absolute;right:17px;top:17px;color:var(--muted); }
.import-window { position:absolute;left:310px;top:140px;width:690px;height:540px;border:1px solid var(--demo-line);border-radius:22px;background:var(--demo-panel);box-shadow:0 25px 80px #0008;overflow:hidden; }
.stage-export .import-window { animation:dialog-enter 11s linear infinite; }
.import-heading { display:flex;align-items:center;gap:12px;height:70px;padding:15px 23px;border-bottom:1px solid var(--demo-line); }
.import-icon { display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:color-mix(in srgb,var(--demo-blue) 12%,var(--demo-panel));color:var(--demo-blue); }
.import-heading > span:nth-child(2) { display:flex;align-items:center;gap:9px; }
.import-heading strong { font-size:18px; }
.import-heading em { padding:3px 7px;border-radius:6px;background:color-mix(in srgb,#f59e0b 14%,var(--demo-panel));color:var(--demo-warning);font-size:9px;font-style:normal;font-weight:850; }
.import-heading > svg { margin-left:auto;color:var(--muted); }
.import-content { position:relative;height:470px;padding:23px; }
.menu-pane,.export-pane,.preview-pane,.mode-pane { position:absolute;inset:23px; }
.menu-pane { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-content:start;opacity:0; }
.menu-card { position:relative;display:grid;align-content:start;gap:12px;height:190px;padding:25px;border:2px solid var(--demo-line);border-radius:19px;background:var(--demo-field); }
.menu-card svg { color:var(--demo-blue); }
.menu-card strong { font-size:19px; }
.stage-export .menu-pane { animation:export-menu 11s linear infinite; }
.stage-preview .menu-pane { animation:preview-menu 10s linear infinite; }
.pane-heading { display:flex;align-items:center;gap:10px;margin-bottom:15px;color:var(--demo-blue);font-size:17px; }
.pane-heading strong { color:var(--text); }
.export-pane { display:grid;align-content:start;gap:15px;padding:4px 12px; }
.stage-export .export-pane { animation:export-form 11s linear infinite; }
.filename-tag { display:grid;gap:6px;color:var(--muted);font-size:11px;font-weight:850; }
.input-look { display:block;width:100%;height:37px;border:1px solid var(--demo-line);border-radius:9px;background:var(--demo-field); }
.exclusions { display:flex;gap:12px 16px;flex-wrap:wrap; }
.check-item { position:relative;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px;font-weight:750; }
.fake-check { display:grid;place-items:center;width:16px;height:16px;border:1px solid var(--demo-line);border-radius:4px;background:var(--demo-field);color:white; }
.history-choice .fake-check { animation:history-select 11s linear infinite; }
.history-choice .fake-check svg { opacity:0;animation:history-check 11s linear infinite; }
.filename-preview { display:grid;justify-items:center;gap:3px;padding:13px;border:1px solid var(--demo-line);border-radius:10px;background:var(--demo-field); }
.filename-preview small { color:var(--muted);font-size:10px;text-transform:uppercase; }
.filename-preview strong { color:var(--demo-blue);font:750 13px/1.5 ui-monospace,SFMono-Regular,monospace; }
.action-row { display:flex;align-items:center;justify-content:flex-end;gap:15px;margin-top:7px; }
.primary-action { position:relative;display:flex;align-items:center;gap:7px;padding:11px 17px;border:1px solid #1d4ed8;border-radius:10px;background:#2563eb;color:white;font-size:12px;font-weight:850; }
.success-message,.import-progress { display:flex;align-items:center;gap:7px;color:var(--green);font-size:12px;font-weight:800;opacity:0; }
.stage-export .success-message { animation:export-done 11s linear infinite; }
.upload-row { display:flex;align-items:center;gap:15px;padding:13px;border:1px dashed var(--demo-line);border-radius:11px;background:var(--demo-field); }
.upload-action { position:relative;display:flex;align-items:center;gap:7px;padding:9px 12px;border:1px solid var(--demo-line);border-radius:8px;background:var(--demo-panel);font-size:11px;font-weight:850; }
.upload-row strong { color:var(--demo-blue);font:750 12px/1.4 ui-monospace,SFMono-Regular,monospace; }
.stats-grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px; }
.stats-grid > div { display:grid;justify-items:center;padding:12px;border:1px solid var(--demo-line);border-radius:11px;background:var(--demo-field); }
.stats-grid strong { font-size:22px; }
.stats-grid small { color:var(--muted);font-size:10px; }
.content-preview { display:grid;gap:8px;margin-top:16px;padding:15px;border:1px solid var(--demo-line);border-radius:11px; }
.content-preview > strong { color:var(--muted);font-size:10px;text-transform:uppercase; }
.content-preview > span { display:flex;align-items:center;gap:8px;color:var(--demo-blue);font-size:12px;font-weight:800; }
.content-preview .chat-row { padding-left:25px;color:var(--text); }
.preview-pane .action-row { margin-top:17px; }
.stage-preview .preview-pane { animation:preview-form 10s linear infinite; }
.stage-mode .preview-pane { animation:mode-preview 11s linear infinite; }
.mode-pane { display:grid;align-content:start;gap:13px;opacity:0; }
.stage-mode .mode-pane { animation:mode-form 11s linear infinite; }
.archive-summary { display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--demo-line);border-radius:9px;background:var(--demo-field);font-size:11px; }
.archive-summary svg { color:var(--demo-blue); }
.archive-summary > span { margin-left:auto;color:var(--muted);font-size:10px; }
.mode-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px; }
.mode-card { position:relative;display:grid;grid-template-columns:19px minmax(0,1fr) 18px;align-items:start;gap:9px;min-height:98px;padding:15px;border:2px solid var(--demo-line);border-radius:14px;background:var(--demo-field); }
.mode-card > svg:first-child { color:var(--demo-blue); }
.mode-card strong,.mode-card small { display:block;overflow-wrap:anywhere; }
.mode-card strong { font-size:13px; }
.mode-card small { margin-top:5px;color:var(--muted);font-size:11px; }
.append-card { border-color:var(--demo-blue);background:color-mix(in srgb,var(--demo-blue) 9%,var(--demo-panel)); }
.radio-mark { display:grid;place-items:center;width:18px;height:18px;border:1px solid var(--demo-line);border-radius:50%; }
.append-card .radio-mark { border-color:var(--demo-blue);background:var(--demo-blue);color:white; }
.replace-warning { margin:0;color:var(--demo-warning);font-size:11px;font-weight:750; }
.settings-fields { display:grid;gap:6px;padding:13px;border:1px solid var(--demo-line);border-radius:10px; }
.settings-fields > strong { font-size:12px; }
.settings-fields > div { display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:11px; }
.settings-fields em { color:var(--demo-blue);font-style:normal;font-weight:750; }
.stage-mode .import-progress { position:relative;display:grid;opacity:1; }
.import-progress > span { grid-area:1/1;display:flex;align-items:center;gap:5px; }
.verify { opacity:0;animation:verify-status 11s linear infinite; }
.import-done { opacity:0;animation:import-result 11s linear infinite; }
.pointer { position:absolute;z-index:5;right:0;bottom:-10px;fill:var(--demo-panel);color:var(--text);filter:drop-shadow(0 1px 2px #0009);pointer-events:none; }
.manage-pointer { animation:manage-pointer 11s linear infinite; }
.menu-pointer { animation:menu-pointer 11s linear infinite; }
.stage-preview .menu-pointer { animation:preview-menu-pointer 10s linear infinite; }
.history-pointer { animation:history-pointer 11s linear infinite; }
.export-pointer { animation:export-pointer 11s linear infinite; }
.upload-pointer { animation:upload-pointer 10s linear infinite; }
.next-pointer { animation:next-pointer 11s linear infinite; }
.append-pointer { animation:append-pointer 11s linear infinite; }
.import-pointer { animation:import-pointer 11s linear infinite; }
@keyframes camera-export { 0%,17% { transform:translate(-380px,-150px) scale(1); } 34%,100% { transform:translate(-280px,-205px) scale(.95); } }
@keyframes camera-preview { 0%,22% { transform:translate(-280px,-205px) scale(.95); } 38%,100% { transform:translate(-280px,-270px) scale(.95); } }
@keyframes camera-mode { 0%,26% { transform:translate(-280px,-270px) scale(.95); } 44%,100% { transform:translate(-310px,-235px) scale(1); } }
@keyframes dialog-enter { 0%,17% { opacity:0;transform:translateY(8px); } 30%,100% { opacity:1;transform:none; } }
@keyframes manage-highlight { 0%,9%,26%,100% { box-shadow:none; } 14%,20% { box-shadow:0 0 0 5px color-mix(in srgb,var(--demo-blue) 23%,transparent); } }
@keyframes export-menu { 0%,30% { opacity:1; } 39%,100% { opacity:0; } }
@keyframes preview-menu { 0%,20% { opacity:1; } 30%,100% { opacity:0; } }
@keyframes export-form { 0%,33% { opacity:0; } 43%,100% { opacity:1; } }
@keyframes preview-form { 0%,24% { opacity:0; } 35%,100% { opacity:1; } }
@keyframes mode-preview { 0%,27% { opacity:1; } 38%,100% { opacity:0; } }
@keyframes mode-form { 0%,31% { opacity:0; } 42%,100% { opacity:1; } }
@keyframes history-select { 0%,53% { background:var(--demo-field); } 63%,100% { background:var(--demo-blue); } }
@keyframes history-check { 0%,53% { opacity:0; } 63%,100% { opacity:1; } }
@keyframes export-done { 0%,84% { opacity:0; } 93%,100% { opacity:1; } }
@keyframes verify-status { 0%,72%,90%,100% { opacity:0; } 78%,85% { opacity:1; } }
@keyframes import-result { 0%,87% { opacity:0; } 94%,100% { opacity:1; } }
@keyframes manage-pointer { 0%,8%,26%,100% { opacity:0;transform:translate(9px,9px); } 14%,20% { opacity:1;transform:none; } }
@keyframes menu-pointer { 0%,20%,36%,100% { opacity:0;transform:translate(9px,9px); } 25%,31% { opacity:1;transform:none; } }
@keyframes preview-menu-pointer { 0%,7%,24%,100% { opacity:0;transform:translate(9px,9px); } 12%,18% { opacity:1;transform:none; } }
@keyframes history-pointer { 0%,51%,67%,100% { opacity:0;transform:translate(9px,9px); } 57%,62% { opacity:1;transform:none; } }
@keyframes export-pointer { 0%,73%,87%,100% { opacity:0;transform:translate(9px,9px); } 78%,83% { opacity:1;transform:none; } }
@keyframes upload-pointer { 0%,34%,53%,100% { opacity:0;transform:translate(9px,9px); } 41%,48% { opacity:1;transform:none; } }
@keyframes next-pointer { 0%,13%,31%,100% { opacity:0;transform:translate(9px,9px); } 20%,26% { opacity:1;transform:none; } }
@keyframes append-pointer { 0%,43%,58%,100% { opacity:0;transform:translate(9px,9px); } 49%,54% { opacity:1;transform:none; } }
@keyframes import-pointer { 0%,64%,79%,100% { opacity:0;transform:translate(9px,9px); } 70%,75% { opacity:1;transform:none; } }
@media(max-width:620px) {
  .backup-viewport { height:320px; }
  .stage-export .camera { transform:translate(-550px,-230px) scale(.85);animation-name:camera-export-mobile; }
  .stage-preview .camera { transform:translate(-280px,-230px) scale(.85);animation-name:camera-preview-mobile; }
  .stage-mode .camera { transform:translate(-280px,-230px) scale(.85);animation-name:camera-mode-mobile; }
  .stage-mode .import-progress { position:absolute;left:0;bottom:65px; }
  @keyframes camera-export-mobile { 0%,17% { transform:translate(-600px,-110px) scale(.85); } 34%,66% { transform:translate(-350px,-155px) scale(.85); } 78%,100% { transform:translate(-550px,-230px) scale(.85); } }
  @keyframes camera-preview-mobile { 0%,22% { transform:translate(-550px,-230px) scale(.85); } 36%,100% { transform:translate(-280px,-230px) scale(.85); } }
  @keyframes camera-mode-mobile { 0%,12% { transform:translate(-280px,-230px) scale(.85); } 23%,32% { transform:translate(-550px,-230px) scale(.85); } 44%,63% { transform:translate(-280px,-230px) scale(.85); } 70%,82% { transform:translate(-560px,-230px) scale(.85); } 90%,100% { transform:translate(-280px,-230px) scale(.85); } }
}
:global(html:has(#docs-pause-motion:checked)) .backup-viewport *,
:global(html:has(#docs-pause-motion:checked)) .backup-viewport *::before,
:global(html:has(#docs-pause-motion:checked)) .backup-viewport *::after { animation:none!important; }
:global(html:has(#docs-pause-motion:checked)) .stage-export .import-window,:global(html:has(#docs-pause-motion:checked)) .stage-export .export-pane,:global(html:has(#docs-pause-motion:checked)) .stage-preview .preview-pane,:global(html:has(#docs-pause-motion:checked)) .stage-mode .mode-pane,:global(html:has(#docs-pause-motion:checked)) .stage-export .success-message,:global(html:has(#docs-pause-motion:checked)) .stage-mode .import-done { opacity:1;transform:none; }
:global(html:has(#docs-pause-motion:checked)) .menu-pane,:global(html:has(#docs-pause-motion:checked)) .stage-mode .preview-pane,:global(html:has(#docs-pause-motion:checked)) .stage-mode .verify { opacity:0; }
:global(html:has(#docs-pause-motion:checked)) .history-choice .fake-check { background:var(--demo-blue); }
:global(html:has(#docs-pause-motion:checked)) .history-choice .fake-check svg { opacity:1; }
:global(html:has(#docs-pause-motion:checked)) .pointer { display:none; }
@media(prefers-reduced-motion:reduce) { .backup-viewport *, .backup-viewport *::before, .backup-viewport *::after { animation:none!important; } .stage-export .import-window,.stage-export .export-pane,.stage-preview .preview-pane,.stage-mode .mode-pane,.stage-export .success-message,.stage-mode .import-done { opacity:1;transform:none; } .menu-pane,.stage-mode .preview-pane,.stage-mode .verify { opacity:0; } .history-choice .fake-check { background:var(--demo-blue); } .history-choice .fake-check svg { opacity:1; } .pointer { display:none; } }
</style>
