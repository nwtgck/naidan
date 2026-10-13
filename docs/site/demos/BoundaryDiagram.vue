<script setup lang="ts">
import { ArrowDownIcon, ArrowRightIcon, ClipboardIcon, FolderIcon, GlobeIcon, LaptopIcon, ServerIcon, ShieldCheckIcon, ShieldXIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';
import type { BoundaryDiagramCopy } from '../messages';

defineProps<{ copy: BoundaryDiagramCopy }>();

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
      <div class="os-heading"><LaptopIcon :size="18" /><b>{{ copy.os }}</b></div>
      <div class="browser-boundary" data-testid="browser-boundary">
        <div class="browser-heading"><GlobeIcon :size="15" /><b>{{ copy.browser }}</b></div>
        <div class="browser-content">
          <div class="naidan-app" data-testid="naidan-in-browser"><img :src="logo" alt="" width="26" height="26"><b>Naidan</b><small>{{ copy.naidanRuntime }}</small></div>
          <div class="direct-path" data-testid="direct-os-stop"><span>{{ copy.directOperation }}</span><div><ArrowRightIcon class="blocked-arrow" :size="20" /><span class="boundary-stop"><b>{{ copy.blocked }}</b><ShieldXIcon :size="22" /></span></div></div>
        </div>
        <div class="api-gateway" data-testid="browser-api-gateway"><ShieldCheckIcon :size="16" /><b>{{ copy.api }}</b></div>
      </div>
      <div class="permitted-route"><ArrowDownIcon :size="18" /><span>{{ copy.allowed }}</span></div>
      <div class="os-resources">
        <div class="os-resource" data-testid="permitted-files"><FolderIcon :size="18" /><b>{{ copy.files }}</b><p>{{ copy.fileAccess }}</p></div>
        <div class="os-resource" data-testid="permitted-clipboard"><ClipboardIcon :size="18" /><b>{{ copy.clipboard }}</b><p>{{ copy.clipboardAccess }}</p></div>
        <div class="os-resource" data-testid="localhost-api-path"><ServerIcon :size="18" /><b>{{ copy.localServer }}</b><code>HTTP API → localhost</code><p>{{ copy.localhostAccess }}</p></div>
      </div>
      <p class="server-note">{{ copy.serverNote }}</p>
      <p class="boundary-note">{{ copy.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.boundary-map { min-width: 0; font: 11px/1.6 ui-sans-serif, system-ui, sans-serif; }
.os-boundary { padding: 15px; border: 1px solid var(--line-strong); border-radius: 15px; background: var(--surface); }
.os-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 11px; color: var(--text); }
.os-heading > svg { flex-shrink: 0; color: var(--muted); }
.browser-boundary { position: relative; margin: 0 0 12px; padding: 11px 12px 14px; border: 2px solid color-mix(in srgb, var(--blue) 65%, var(--line)); border-radius: 12px; background: var(--bg); }
.browser-heading { display: flex; align-items: center; gap: 7px; color: var(--blue); font-size: 10px; }
.browser-content { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); align-items: center; gap: 16px; margin: 11px 0 15px; }
.naidan-app { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 0; padding: 12px 8px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface-2); text-align: center; }
.naidan-app b { font-size: 14px; }
.naidan-app small { color: var(--muted); font-size: 9px; line-height: 1.7; overflow-wrap: anywhere; }
.direct-path { min-width: 0; color: var(--muted); font-size: 9px; line-height: 1.8; }
.direct-path > span { display: block; margin-bottom: 6px; }
.direct-path > div { display: flex; align-items: center; gap: 9px; }
.blocked-arrow { flex-shrink: 0; color: #d9a15a; animation: docs-blocked-operation 7s ease-in-out infinite; }
.boundary-stop { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex: 1; min-width: 0; color: #c78d43; }
.boundary-stop svg { flex-shrink: 0; margin-right: -25px; padding: 2px; box-sizing: content-box; background: var(--bg); }
.boundary-stop b { font-size: 9px; font-weight: 600; line-height: 1.7; overflow-wrap: anywhere; }
.api-gateway { display: flex; align-items: center; justify-content: center; gap: 7px; width: fit-content; max-width: 100%; margin: 0 auto -26px; padding: 6px 10px; border: 1px solid var(--green); border-radius: 7px; background: var(--surface); color: var(--green); font-size: 10px; line-height: 1.7; }
.api-gateway svg { flex-shrink: 0; }
.api-gateway b { overflow-wrap: anywhere; font-weight: 600; }
.permitted-route { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 11px 0 8px; color: var(--green); font-size: 9px; line-height: 1.7; }
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
  .browser-boundary { padding: 9px 9px 14px; }
  .browser-content { gap: 10px; }
  .direct-path > div { gap: 5px; }
  .boundary-stop b { font-size: 8px; }
  .boundary-stop svg { margin-right: -21px; }
  .os-resources { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .os-resource { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 3px 8px; padding: 8px; }
  .os-resource > svg { grid-row: 1 / 4; margin: 1px 0 0; }
  .os-resource p, .os-resource code { grid-column: 2; margin: 0; }
}
</style>
