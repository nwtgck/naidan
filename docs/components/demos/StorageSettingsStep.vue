<script setup lang="ts">
import { CheckCircle2Icon, DatabaseIcon, FileArchiveIcon, GhostIcon, HardDriveIcon, MousePointer2Icon, Settings2Icon, SettingsIcon, ShieldCheckIcon, XIcon } from 'lucide-vue-next';

defineProps<{ stage: 'open' | 'choose' | 'persist'; messages: typeof import('../../pages/data-storage/messages/en').messages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="storage-viewport" :class="`stage-${stage}`" :data-docs-animation="`storage-${stage}`" :data-testid="`storage-step-${stage}`" aria-hidden="true">
    <div class="camera">
      <div class="app-canvas">
        <aside class="app-sidebar">
          <strong class="brand">Naidan</strong>
          <div class="app-chat-line" /><div class="app-chat-line short" /><div class="app-chat-line" />
          <div class="app-sidebar-bottom"><SettingsIcon :size="18" />{{ messages.settings }}<MousePointer2Icon v-if="stage === 'open'" class="pointer app-pointer" :size="24" /></div>
        </aside>
        <div class="app-background"><div class="app-toolbar" /><div class="app-empty-chat" /></div>

        <div class="settings-window">
          <aside class="settings-sidebar">
            <div class="settings-heading"><span class="settings-icon"><Settings2Icon :size="19" /></span><strong>{{ messages.settings }}</strong><small>{{ messages.english }}</small></div>
            <nav class="settings-nav">
              <div>{{ messages.connection }}</div><div>{{ messages.tools }}</div><div>{{ messages.models }}</div>
              <div class="storage-nav"><DatabaseIcon :size="17" />{{ messages.storage }}<MousePointer2Icon v-if="stage === 'open'" class="pointer nav-pointer" :size="23" /></div>
              <div>{{ messages.files }}</div><div>{{ messages.about }}</div>
            </nav>
            <div class="settings-footer"><span class="theme-dot" />{{ messages.settings }}</div>
          </aside>
          <main class="settings-main">
            <div class="settings-content">
              <section class="durability-section">
                <h3><ShieldCheckIcon :size="19" />{{ messages.data_durability }}</h3>
                <div class="durability-card">
                  <div class="durability-copy"><strong>{{ messages.persistent_storage }}</strong><span>{{ messages.ask_the_browser_to_protect_saved }}</span><span class="persistence-result"><CheckCircle2Icon :size="14" />{{ messages.protected }}</span></div>
                  <div class="durability-status"><span class="status-before">{{ messages.best_effort }}</span><span class="status-after">{{ messages.active }}</span></div>
                  <div class="enable-action"><span class="enable-before">{{ messages.enable }}</span><span class="enable-after"><CheckCircle2Icon :size="15" />{{ messages.protected }}</span><MousePointer2Icon v-if="stage === 'persist'" class="pointer enable-pointer" :size="23" /></div>
                </div>
              </section>

              <section class="backup-section"><h3><FileArchiveIcon :size="19" />{{ messages.backup_restore }}</h3><div class="backup-card"><FileArchiveIcon :size="22" /><span>{{ messages.backup_restore }}</span><span class="secondary-action">{{ messages.manage_data }}</span></div></section>

              <section class="storage-section">
                <h3><DatabaseIcon :size="19" />{{ messages.storage_management }}</h3>
                <div class="field-label">{{ messages.active_storage_provider }}</div>
                <div class="provider-grid">
                  <div class="provider-card opfs-card"><div class="provider-top"><HardDriveIcon :size="20" /><em>{{ messages.recommended }}</em></div><strong>{{ messages.origin_private_file_system_opfs }}</strong><p>{{ messages.large_data_and_attachments }}</p></div>
                  <div class="provider-card local-card"><div class="provider-top"><HardDriveIcon :size="20" /></div><strong>{{ messages.local_storage }}</strong><p>{{ messages.small_browser_storage_sent_images_are_not_kept }}</p></div>
                  <div class="provider-card memory-card"><div class="provider-top"><GhostIcon :size="20" /></div><strong>{{ messages.ephemeral }}</strong><p>{{ messages.conversation_data_lasts_until_reload_or_tab_closure }}</p><MousePointer2Icon v-if="stage === 'choose'" class="pointer choice-pointer" :size="23" /></div>
                </div>
                <div class="storage-note">{{ messages.switch_to_ephemeral_your_chats_groups }}</div>
              </section>
            </div>
          </main>
          <div class="window-close"><XIcon :size="18" /></div>
        </div>

        <div class="confirm-layer"><div class="confirm-dialog"><strong>{{ messages.confirm_storage_switch }}</strong><p>{{ messages.switch_to_ephemeral_your_chats_groups }}</p><div class="confirm-actions"><span>{{ messages.cancel }}</span><span class="confirm-primary">{{ messages.switch_migrate }}<MousePointer2Icon v-if="stage === 'choose'" class="pointer confirm-pointer" :size="23" /></span></div></div></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.storage-viewport { --demo-panel:var(--surface);--demo-field:var(--surface-2);--demo-line:var(--line-strong);--demo-blue:var(--blue);--demo-warning:#fbbf24;position:relative;width:100%;max-width:680px;height:350px;margin-inline:auto;overflow:hidden;border:1px solid var(--demo-line);border-radius:15px;background:var(--bg);color:var(--text);box-shadow:var(--panel-shadow); }
html:has(#docs-light-theme:checked) .storage-viewport { --demo-warning:#92400e; }
.camera { width:1120px;height:760px;transform-origin:top left;will-change:transform; }
.stage-open .camera { transform:translate(-165px,-155px) scale(.92);animation:camera-open 10s ease-in-out infinite; }
.stage-choose .camera { transform:translate(-370px,-290px) scale(1);animation:camera-choose 11s ease-in-out infinite; }
.stage-persist .camera { transform:translate(-370px,-50px) scale(1);animation:camera-persist 9s ease-in-out infinite; }
.app-canvas { position:relative;width:1120px;height:760px;background:var(--demo-field);font:13px/1.45 ui-sans-serif,system-ui,sans-serif; }
.app-sidebar { position:absolute;inset:0 auto 0 0;display:flex;flex-direction:column;width:154px;padding:23px 15px;background:var(--demo-panel);border-right:1px solid var(--demo-line); }
.brand { margin-bottom:38px;font-size:19px;letter-spacing:-.04em; }
.app-chat-line { height:25px;margin-bottom:12px;border-radius:9px;background:var(--demo-field); }
.app-chat-line.short { width:72%; }
.app-sidebar-bottom { position:relative;display:flex;align-items:center;gap:9px;margin-top:auto;padding:12px 10px;border:1px solid var(--demo-line);border-radius:11px;color:var(--muted);font-weight:750; }
.app-background { position:absolute;inset:0 0 0 154px; }
.app-toolbar { height:62px;border-bottom:1px solid var(--demo-line);background:var(--demo-panel); }
.app-empty-chat { width:340px;height:210px;margin:190px auto;border:1px dashed var(--demo-line);border-radius:20px; }
.settings-window { position:absolute;left:170px;top:36px;display:grid;grid-template-columns:220px 670px;width:890px;height:690px;border:1px solid var(--demo-line);border-radius:22px;background:var(--demo-panel);box-shadow:0 24px 70px #0005;overflow:hidden; }
.stage-open .settings-window { animation:window-enter 10s ease-in-out infinite; }
.settings-sidebar { position:relative;display:flex;flex-direction:column;background:var(--demo-field);border-right:1px solid var(--demo-line); }
.settings-heading { display:flex;align-items:center;gap:9px;min-height:70px;padding:15px;border-bottom:1px solid var(--demo-line); }
.settings-icon { display:grid;place-items:center;width:35px;height:35px;border:1px solid var(--demo-line);border-radius:10px;background:var(--demo-panel);color:var(--demo-blue); }
.settings-heading strong { font-size:17px; }
.settings-heading small { margin-left:auto;color:var(--muted);font-size:10px; }
.settings-nav { display:grid;align-content:start;gap:5px;padding:14px; }
.settings-nav > div { display:flex;align-items:center;gap:9px;min-height:42px;padding:10px 13px;border:1px solid transparent;border-radius:10px;color:var(--muted);font-weight:750; }
.settings-nav .storage-nav { position:relative;border-color:var(--demo-line);background:var(--demo-panel);color:var(--demo-blue); }
.settings-footer { display:flex;align-items:center;gap:8px;margin-top:auto;padding:14px;border-top:1px solid var(--demo-line);color:var(--muted);font-size:11px; }
.theme-dot { width:17px;height:17px;border:2px solid var(--demo-line);border-radius:50%; }
.settings-main { min-width:0;background:var(--demo-panel); }
.settings-content { padding:28px; }
.settings-content section { margin:0 0 28px; }
.settings-content h3 { display:flex;align-items:center;gap:9px;margin:0 0 15px;padding-bottom:12px;border-bottom:1px solid var(--demo-line);font-size:18px; }
.settings-content h3 svg { flex:none;color:var(--demo-blue); }
.durability-card { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:center;padding:15px 18px;border:1px solid var(--demo-line);border-radius:18px;background:var(--demo-field); }
.durability-copy { grid-row:span 2;display:grid;gap:4px; }
.durability-copy strong { font-size:14px; }
.durability-copy span { color:var(--muted);font-size:11px; }
.durability-copy .persistence-result { display:none;align-items:center;gap:5px;color:var(--green);font-weight:800; }
.durability-status,.enable-action { position:relative;display:grid;justify-self:end; }
.durability-status > span,.enable-action > span { grid-area:1/1;display:flex;align-items:center;justify-content:center;gap:5px; }
.durability-status > span { padding:3px 7px;border-radius:6px;font-size:10px;font-weight:850; }
.status-before { background:color-mix(in srgb,#f59e0b 14%,var(--demo-panel));color:var(--demo-warning); }
.status-after { opacity:0;background:color-mix(in srgb,var(--green) 15%,var(--demo-panel));color:var(--green); }
.enable-action > span { min-width:92px;padding:8px 11px;border-radius:9px;font-size:11px;font-weight:850; }
.enable-before { background:#2563eb;color:white; }
.enable-after { opacity:0;background:color-mix(in srgb,var(--green) 15%,var(--demo-panel));color:var(--green); }
.stage-persist .status-before,.stage-persist .enable-before { animation:old-persistence 9s linear infinite; }
.stage-persist .status-after,.stage-persist .enable-after { animation:new-persistence 9s linear infinite; }
.backup-card { display:flex;align-items:center;gap:12px;padding:15px 18px;border:1px solid var(--demo-line);border-radius:18px;background:var(--demo-field);font-weight:750; }
.backup-card > svg { color:var(--demo-blue); }
.secondary-action { margin-left:auto;padding:8px 12px;border:1px solid var(--demo-line);border-radius:9px;background:var(--demo-panel);color:var(--text);font-size:11px; }
.field-label { margin:0 0 10px;color:var(--muted);font-size:11px;font-weight:850;letter-spacing:.05em;text-transform:uppercase; }
.provider-grid { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px; }
.provider-card { position:relative;display:flex;flex-direction:column;min-width:0;min-height:164px;padding:14px;border:2px solid var(--demo-line);border-radius:15px;background:var(--demo-panel); }
.provider-top { display:flex;align-items:center;justify-content:space-between;min-height:25px;margin-bottom:12px; }
.provider-top svg { color:var(--muted); }
.provider-top em { color:var(--green);font-size:9px;font-style:normal;font-weight:850; }
.provider-card strong { font-size:14px;line-height:1.3;overflow-wrap:anywhere; }
.provider-card p { margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.45;overflow-wrap:anywhere; }
.opfs-card { border-color:var(--demo-blue);background:color-mix(in srgb,var(--demo-blue) 10%,var(--demo-panel)); }
.stage-choose .opfs-card { animation:unselect-opfs 11s linear infinite; }
.stage-choose .memory-card { animation:select-memory 11s linear infinite; }
.stage-persist .opfs-card { border-color:var(--demo-line);background:var(--demo-panel); }
.stage-persist .memory-card { border-color:#a855f7;background:color-mix(in srgb,#a855f7 11%,var(--demo-panel)); }
.storage-note { margin-top:12px;padding:11px 14px;border:1px solid color-mix(in srgb,var(--demo-blue) 25%,var(--demo-line));border-radius:11px;background:color-mix(in srgb,var(--demo-blue) 7%,var(--demo-panel));color:var(--muted);font-size:11px; }
.window-close { position:absolute;right:17px;top:17px;color:var(--muted); }
.confirm-layer { position:absolute;inset:0;display:grid;place-items:center;background:#0008;opacity:0;pointer-events:none; }
.stage-choose .confirm-layer { animation:confirm-appear 11s linear infinite; }
.confirm-dialog { width:440px;padding:22px;border:1px solid var(--demo-line);border-radius:17px;background:var(--demo-panel);box-shadow:0 18px 50px #0006; }
.confirm-dialog strong { font-size:16px; }
.confirm-dialog p { color:var(--muted);font-size:13px; }
.confirm-actions { display:flex;justify-content:flex-end;gap:9px;margin-top:16px;font-weight:800; }
.confirm-actions > span { padding:9px 13px;border-radius:8px; }
.confirm-primary { position:relative;background:#2563eb;color:white; }
.pointer { position:absolute;z-index:4;right:2px;bottom:-10px;fill:var(--demo-panel);color:var(--text);filter:drop-shadow(0 1px 2px #0009);pointer-events:none; }
.app-pointer { animation:app-pointer 10s linear infinite; }
.nav-pointer { animation:nav-pointer 10s linear infinite; }
.choice-pointer { animation:choice-pointer 11s linear infinite; }
.confirm-pointer { animation:confirm-pointer 11s linear infinite; }
.enable-pointer { animation:enable-pointer 9s linear infinite; }
@keyframes camera-open { 0%,21% { transform:translate(0px,-380px) scale(.92); } 37%,100% { transform:translate(-165px,-155px) scale(.92); } }
@keyframes camera-choose { 0%,12% { transform:translate(-165px,-155px) scale(.92); } 28%,42% { transform:translate(-370px,-290px) scale(1); } 54%,72% { transform:translate(-380px,-165px) scale(1); } 86%,100% { transform:translate(-370px,-290px) scale(1); } }
@keyframes camera-persist { 0%,12% { transform:translate(-370px,-290px) scale(1); } 31%,100% { transform:translate(-370px,-50px) scale(1); } }
@keyframes window-enter { 0%,25% { opacity:0;transform:translateY(8px); } 38%,100% { opacity:1;transform:none; } }
@keyframes unselect-opfs { 0%,31% { border-color:var(--demo-blue);background:color-mix(in srgb,var(--demo-blue) 10%,var(--demo-panel)); } 39%,100% { border-color:var(--demo-line);background:var(--demo-panel); } }
@keyframes select-memory { 0%,31% { border-color:var(--demo-line);background:var(--demo-panel); } 39%,100% { border-color:#a855f7;background:color-mix(in srgb,#a855f7 11%,var(--demo-panel)); } }
@keyframes confirm-appear { 0%,43%,76%,100% { opacity:0; } 50%,69% { opacity:1; } }
@keyframes old-persistence { 0%,48% { opacity:1; } 62%,100% { opacity:0; } }
@keyframes new-persistence { 0%,48% { opacity:0; } 62%,100% { opacity:1; } }
@keyframes app-pointer { 0%,8%,25%,100% { opacity:0;transform:translate(10px,10px); } 13%,20% { opacity:1;transform:none; } }
@keyframes nav-pointer { 0%,43%,66%,100% { opacity:0;transform:translate(10px,10px); } 50%,58% { opacity:1;transform:none; } }
@keyframes choice-pointer { 0%,28%,44%,100% { opacity:0;transform:translate(10px,10px); } 34%,39% { opacity:1;transform:none; } }
@keyframes confirm-pointer { 0%,58%,74%,100% { opacity:0;transform:translate(10px,10px); } 64%,69% { opacity:1;transform:none; } }
@keyframes enable-pointer { 0%,40%,59%,100% { opacity:0;transform:translate(10px,10px); } 47%,53% { opacity:1;transform:none; } }
@media(max-width:620px) {
  .storage-viewport { height:320px; }
  .stage-open .camera { transform:translate(-130px,-100px) scale(.9);animation-name:camera-open-mobile; }
  .stage-choose .camera { transform:translate(-657px,-230px) scale(.9);animation-name:camera-choose-mobile; }
  .stage-persist .camera { transform:translate(-350px,0px) scale(.9);animation-name:camera-persist-mobile; }
  .confirm-dialog { width:330px;padding:16px; }
  .confirm-dialog strong { font-size:14px; }
  .confirm-dialog p { font-size:12px; }
  .confirm-actions { gap:5px;margin-top:10px;font-size:11px; }
  .confirm-actions > span { padding:7px 9px; }
  .durability-copy .persistence-result { display:flex;opacity:0; }
  .stage-persist .persistence-result { animation:persistence-result 9s linear infinite; }
  @keyframes camera-open-mobile { 0%,21% { transform:translate(0px,-430px) scale(.9); } 37%,100% { transform:translate(-130px,-100px) scale(.9); } }
  @keyframes camera-choose-mobile { 0%,12% { transform:translate(-130px,-100px) scale(.9); } 28% { transform:translate(-350px,-230px) scale(.9); } 41% { transform:translate(-657px,-230px) scale(.9); } 54%,72% { transform:translate(-367px,-180px) scale(.9); } 86%,100% { transform:translate(-657px,-230px) scale(.9); } }
  @keyframes camera-persist-mobile { 0%,12% { transform:translate(-657px,-230px) scale(.9); } 31% { transform:translate(-350px,0px) scale(.9); } 56%,77% { transform:translate(-650px,0px) scale(.9); } 87%,100% { transform:translate(-350px,0px) scale(.9); } }
  @keyframes persistence-result { 0%,62% { opacity:0; } 72%,100% { opacity:1; } }
}
html:has(#docs-pause-motion:checked) .storage-viewport *,
html:has(#docs-pause-motion:checked) .storage-viewport *::before,
html:has(#docs-pause-motion:checked) .storage-viewport *::after { animation:none!important; }
html:has(#docs-pause-motion:checked) .stage-open .settings-window { opacity:1;transform:none; }
html:has(#docs-pause-motion:checked) .stage-choose .opfs-card { border-color:var(--demo-line);background:var(--demo-panel); }
html:has(#docs-pause-motion:checked) .stage-choose .memory-card { border-color:#a855f7;background:color-mix(in srgb,#a855f7 11%,var(--demo-panel)); }
html:has(#docs-pause-motion:checked) .stage-persist .status-after,html:has(#docs-pause-motion:checked) .stage-persist .enable-after,html:has(#docs-pause-motion:checked) .stage-persist .persistence-result { opacity:1; }
html:has(#docs-pause-motion:checked) .stage-persist .status-before,html:has(#docs-pause-motion:checked) .stage-persist .enable-before { opacity:0; }
html:has(#docs-pause-motion:checked) .pointer { display:none; }
@media(prefers-reduced-motion:reduce) { .storage-viewport *, .storage-viewport *::before, .storage-viewport *::after { animation:none!important; } .stage-open .settings-window { opacity:1;transform:none; } .stage-choose .opfs-card { border-color:var(--demo-line);background:var(--demo-panel); } .stage-choose .memory-card { border-color:#a855f7;background:color-mix(in srgb,#a855f7 11%,var(--demo-panel)); } .stage-persist .status-after,.stage-persist .enable-after,.stage-persist .persistence-result { opacity:1; } .stage-persist .status-before,.stage-persist .enable-before { opacity:0; } .pointer { display:none; } }
</style>
