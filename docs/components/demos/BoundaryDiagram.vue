<script setup lang="ts">
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ClipboardIcon, FolderIcon, GlobeIcon, LaptopIcon, RotateCwIcon, ServerIcon, ShieldCheckIcon, WaypointsIcon, XIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';
type BoundaryDiagramMessages = typeof import('../../pages/browser-boundaries/messages/en').messages | typeof import('../../pages/index/messages/en').messages;

defineProps<{ messages: BoundaryDiagramMessages }>();

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
  <div class="boundary-map" data-testid="boundary-diagram" data-docs-animation="permission-paths" aria-hidden="true">
    <div class="os-boundary" data-testid="os-boundary">
      <div class="os-heading"><LaptopIcon :size="18" /><b>{{ messages.the_os_on_this_pc }}</b></div>
      <div class="browser-boundary" data-testid="browser-boundary">
        <div class="browser-chrome" data-testid="boundary-browser-chrome">
          <div class="browser-tabs"><span class="browser-tab"><img :src="logo" alt="" width="12" height="12"><b>Naidan</b><XIcon :size="10" /></span><span class="browser-label">{{ messages.browser }}</span></div>
          <div class="browser-toolbar"><ArrowLeftIcon class="browser-back" :size="12" /><RotateCwIcon :size="12" /><span class="browser-address"><GlobeIcon :size="11" /><code>naidan.pages.dev</code></span></div>
        </div>
        <div class="browser-content">
          <div class="naidan-app" data-testid="naidan-in-browser"><img :src="logo" alt="" width="26" height="26"><b>Naidan</b><small>{{ messages.runs_inside_the_browser }}</small></div>
          <div class="direct-path" data-testid="direct-os-stop"><span>{{ messages.attempt_a_direct_os_operation }}</span><div><ArrowRightIcon class="blocked-arrow" :size="20" /><span class="boundary-stop"><b>{{ messages.direct_access_prevented }}</b><ShieldCheckIcon :size="22" /></span></div></div>
        </div>
        <div class="api-gateway" data-testid="browser-api-gateway"><WaypointsIcon :size="16" /><b>{{ messages.browser_mediated_apis }}</b></div>
      </div>
      <div class="permitted-route"><ArrowDownIcon :size="18" /><span>{{ messages.scope_and_conditions_depend_on_the_api }}</span></div>
      <div class="os-resources">
        <div class="os-resource" data-testid="permitted-files"><FolderIcon :size="18" /><b>{{ messages.selected_files_and_folders }}</b><p>{{ messages.selected_file_access }}</p></div>
        <div class="os-resource" data-testid="permitted-clipboard"><ClipboardIcon :size="18" /><b>{{ messages.clipboard }}</b><p>{{ messages.clipboard_access }}</p></div>
        <div class="os-resource" data-testid="localhost-api-path"><ServerIcon :size="18" /><b>{{ messages.local_server }}</b><code>HTTP API → localhost</code><p>{{ messages.localhost_http_connection }}</p></div>
      </div>
      <p class="server-note">{{ messages.localhost_server_permissions }}</p>
      <p class="boundary-note">{{ messages.browser_access_note }}</p>
    </div>
  </div>
</template>

<style scoped>
.boundary-map { min-width: 0; font: 11px/1.6 ui-sans-serif, system-ui, sans-serif; }
.os-boundary { padding: 15px; border: 1px solid var(--line-strong); border-radius: 15px; background: var(--surface); }
.os-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 11px; color: var(--text); }
.os-heading > svg { flex-shrink: 0; color: var(--muted); }
.browser-boundary { position: relative; margin: 0 0 12px; padding: 0 12px 14px; border: 2px solid var(--line-strong); border-radius: 12px; background: var(--bg); }
.browser-chrome { margin: 0 -12px; padding: 6px 9px; border-bottom: 1px solid var(--line); border-radius: 10px 10px 0 0; background: var(--surface-2); color: var(--muted); }
.browser-tabs { display: flex; align-items: center; gap: 8px; }
.browser-tab { display: inline-flex; align-items: center; gap: 6px; padding: 3px 7px; border-radius: 6px 6px 0 0; background: var(--bg); font-size: 9px; line-height: 1.5; }
.browser-tab b { font-weight: 500; }
.browser-tab > svg { margin-left: 13px; color: var(--subtle); }
.browser-label { margin-left: auto; font-size: 9px; }
.browser-toolbar { display: flex; align-items: center; gap: 7px; margin-top: 4px; }
.browser-toolbar > svg { flex-shrink: 0; }
.browser-address { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; padding: 3px 6px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); }
.browser-address svg { flex-shrink: 0; }
.browser-address code { min-width: 0; color: var(--muted); font: 8px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; white-space: normal; }
.browser-content { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); align-items: center; gap: 16px; margin: 11px 0 15px; }
.naidan-app { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 0; padding: 12px 8px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface-2); text-align: center; }
.naidan-app b { font-size: 14px; }
.naidan-app small { color: var(--muted); font-size: 9px; line-height: 1.7; overflow-wrap: anywhere; }
.direct-path { min-width: 0; color: var(--muted); font-size: 9px; line-height: 1.8; }
.direct-path > span { display: block; margin-bottom: 6px; }
.direct-path > div { display: flex; align-items: center; gap: 9px; }
.blocked-arrow { flex-shrink: 0; color: var(--muted); animation: docs-blocked-operation 7s ease-in-out infinite; }
.boundary-stop { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex: 1; min-width: 0; color: color-mix(in srgb, var(--green) 85%, var(--text)); }
.boundary-stop svg { flex-shrink: 0; margin-right: -25px; padding: 2px; box-sizing: content-box; background: var(--bg); }
.boundary-stop b { padding: 3px 5px; border: 1px solid color-mix(in srgb, var(--green) 25%, var(--line)); border-radius: 5px; background: color-mix(in srgb, var(--green) 5%, var(--surface)); font-size: 9px; font-weight: 600; line-height: 1.7; overflow-wrap: anywhere; }
.api-gateway { display: flex; align-items: center; justify-content: center; gap: 7px; width: fit-content; max-width: 100%; margin: 0 auto -26px; padding: 6px 10px; border: 1px solid var(--blue); border-radius: 7px; background: var(--surface); color: var(--blue); font-size: 10px; line-height: 1.7; }
.api-gateway svg { flex-shrink: 0; }
.api-gateway b { overflow-wrap: anywhere; font-weight: 600; }
.permitted-route { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 11px 0 8px; color: var(--blue); font-size: 9px; line-height: 1.7; }
.permitted-route svg { flex-shrink: 0; animation: docs-permitted-operation 7s ease-in-out infinite; }
.os-resources { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.os-resource { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-2); overflow-wrap: anywhere; }
.os-resource > svg { display: block; color: var(--blue); margin-bottom: 5px; }
.os-resource b { display: block; font-size: 9px; font-weight: 600; line-height: 1.7; }
.os-resource p { margin: 4px 0 0; color: var(--muted); font-size: 8px; line-height: 1.85; }
.os-resource code { display: block; margin-top: 4px; color: var(--blue); font: 8px/1.7 ui-monospace, monospace; white-space: normal; }
.server-note, .boundary-note { margin: 9px 0 0; color: var(--muted); font-size: 9px; line-height: 1.85; }
.boundary-note { padding-top: 9px; border-top: 1px solid var(--line); }
@keyframes docs-blocked-operation { 0%, 35%, 100% { opacity: .4; transform: translateX(0); } 10%, 25% { opacity: 1; transform: translateX(4px); } }
@keyframes docs-permitted-operation { 0%, 35%, 100% { opacity: .45; } 50%, 80% { opacity: 1; } }
@media(max-width: 430px) {
  .os-boundary { padding: 11px; }
  .browser-boundary { padding: 0 9px 14px; }
  .browser-chrome { margin: 0 -9px; }
  .browser-back { display: none; }
  .browser-content { gap: 10px; }
  .direct-path > div { gap: 5px; }
  .boundary-stop svg { margin-right: -21px; }
  .os-resources { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .os-resource { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 3px 8px; padding: 8px; }
  .os-resource > svg { grid-row: 1 / 4; margin: 1px 0 0; }
  .os-resource p, .os-resource code { grid-column: 2; margin: 0; }
}
</style>
