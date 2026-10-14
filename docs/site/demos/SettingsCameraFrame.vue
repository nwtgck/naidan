<script setup lang="ts">
import { BookmarkPlusIcon, GlobeIcon, MousePointer2Icon, Settings2Icon, SettingsIcon, SquarePenIcon, WrenchIcon, XIcon } from 'lucide-vue-next';

defineProps<{
  focus: 'open' | 'provider' | 'headers' | 'check' | 'model' | 'select' | 'prepare' | 'save',
  animationId: string,
  testId: string,
  copy: {
    settings: string,
    connection: string,
    tools: string,
    profiles: string,
    newChat: string,
  },
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="settings-camera" :class="`focus-${focus}`" :data-docs-animation="animationId" :data-testid="testId" aria-hidden="true">
    <div class="camera-canvas">
      <aside class="app-rail">
        <strong>Naidan</strong>
        <div class="app-new-chat"><SquarePenIcon :size="16" />{{ copy.newChat }}</div>
        <div class="app-settings"><SettingsIcon :size="17" />{{ copy.settings }}<MousePointer2Icon v-if="focus === 'open'" class="app-pointer" :size="25" /></div>
      </aside>
      <div class="app-backdrop" />
      <div class="settings-modal">
        <aside class="modal-tabs">
          <div class="modal-title"><span class="modal-title-icon"><Settings2Icon :size="19" /></span><strong>{{ copy.settings }}</strong></div>
          <nav>
            <div class="tab selected"><GlobeIcon :size="17" />{{ copy.connection }}</div>
            <div class="tab"><WrenchIcon :size="17" />{{ copy.tools }}</div>
            <div class="tab"><BookmarkPlusIcon :size="17" />{{ copy.profiles }}</div>
          </nav>
        </aside>
        <main class="modal-main">
          <div class="modal-close"><XIcon :size="18" /></div>
          <div class="modal-scroll"><slot /></div>
          <div class="modal-footer"><slot name="footer" /></div>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-camera{--camera-bg:var(--bg);--camera-panel:var(--surface);--camera-field:var(--surface-2);--camera-line:var(--line-strong);--camera-ink:var(--text);--camera-muted:var(--muted);--camera-accent:var(--blue);--right-field:calc(100cqw - 700px);--right-save:calc(100cqw - 770px);container-type:inline-size;position:relative;width:100%;max-width:680px;height:350px;margin-inline:auto;overflow:hidden;border:1px solid var(--camera-line);border-radius:15px;background:var(--camera-bg);box-shadow:var(--panel-shadow);color:var(--camera-ink);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.camera-canvas{position:absolute;left:0;top:0;width:1120px;height:800px;transform-origin:top left}
.app-rail{position:absolute;left:0;top:0;bottom:0;width:205px;padding:24px 16px;background:var(--camera-panel);border-right:1px solid var(--camera-line);display:flex;flex-direction:column;gap:24px}
.app-rail strong{font-size:22px;letter-spacing:-.04em}.app-new-chat,.app-settings{display:flex;align-items:center;gap:10px;padding:12px;border-radius:10px;font-weight:700}.app-new-chat{color:var(--camera-muted);background:var(--camera-field)}.app-settings{position:relative;margin-top:auto;border:1px solid var(--camera-line);background:var(--camera-field)}
.focus-open .app-settings{animation:camera-app-click 8s linear infinite}.app-pointer{position:absolute;right:8px;bottom:-11px;fill:var(--camera-panel);filter:drop-shadow(0 2px 3px #0009);animation:camera-open-pointer 8s linear infinite}
.app-backdrop{position:absolute;left:205px;top:0;right:0;bottom:0;background:linear-gradient(160deg,var(--camera-bg),var(--camera-field))}
.settings-modal{position:absolute;left:150px;top:28px;width:970px;height:714px;display:grid;grid-template-columns:230px minmax(0,1fr);border:1px solid var(--camera-line);border-radius:22px;background:var(--camera-panel);box-shadow:0 24px 70px #0007;overflow:hidden}
.focus-open .settings-modal{animation:camera-modal-appear 8s ease-in-out infinite}
.modal-tabs{display:flex;flex-direction:column;background:var(--camera-field);border-right:1px solid var(--camera-line)}.modal-title{display:flex;align-items:center;gap:12px;padding:21px 17px;border-bottom:1px solid var(--camera-line);font-size:18px}.modal-title-icon{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--camera-line);border-radius:10px;background:var(--camera-panel);color:var(--camera-accent)}.modal-tabs nav{display:grid;align-content:start;gap:7px;padding:15px}.tab{display:flex;align-items:center;gap:10px;padding:12px 13px;border:1px solid transparent;border-radius:11px;color:var(--camera-muted);font-weight:700}.tab.selected{background:var(--camera-panel);border-color:var(--camera-line);box-shadow:0 5px 14px #0001;color:var(--camera-accent)}
.modal-main{position:relative;display:flex;flex-direction:column;min-width:0;background:var(--camera-panel)}.modal-close{position:absolute;z-index:2;right:15px;top:14px;color:var(--camera-muted)}.modal-scroll{flex:1;min-height:0;padding:38px 45px 20px;overflow:hidden}.modal-footer{min-height:74px;padding:14px 35px;border-top:1px solid var(--camera-line);background:var(--camera-field);display:flex;justify-content:flex-end;align-items:center;gap:12px}
.focus-open .camera-canvas{animation:camera-open 8s ease-in-out infinite}
.focus-provider .camera-canvas,.focus-select .camera-canvas{animation:camera-provider 9s ease-in-out infinite}
.focus-headers .camera-canvas{animation:camera-headers 9s ease-in-out infinite}
.focus-check .camera-canvas{animation:camera-check 9s ease-in-out infinite}
.focus-model .camera-canvas{animation:camera-model 10s ease-in-out infinite}
.focus-prepare .camera-canvas{animation:camera-prepare 10s ease-in-out infinite}
.focus-save .camera-canvas{animation:camera-save 9s ease-in-out infinite}
@keyframes camera-open{0%,24%{transform:translate(15px,-480px) scale(.85)}58%,92%{transform:translate(-140px,-7px) scale(.92)}100%{transform:translate(15px,-480px) scale(.85)}}
@keyframes camera-provider{0%,7%{transform:translate(-140px,-7px) scale(.92)}15%,92%{transform:translate(-360px,-50px) scale(1)}100%{transform:translate(-140px,-7px) scale(.92)}}
@keyframes camera-headers{0%,7%{transform:translate(-360px,-50px) scale(1)}17%,92%{transform:translate(-360px,-280px) scale(1)}100%{transform:translate(-360px,-50px) scale(1)}}
@keyframes camera-check{0%,7%{transform:translate(-360px,-280px) scale(1)}13%,92%{transform:translate(-360px,-170px) scale(1)}100%{transform:translate(-360px,-280px) scale(1)}}
@keyframes camera-model{0%,7%{transform:translate(-360px,-170px) scale(1)}16%,58%{transform:translate(-360px,-414px) scale(1)}68%,92%{transform:translate(-430px,-414px) scale(1)}100%{transform:translate(-360px,-170px) scale(1)}}
@keyframes camera-prepare{0%,7%{transform:translate(-360px,-50px) scale(1)}15%,92%{transform:translate(-360px,-135px) scale(1)}100%{transform:translate(-360px,-50px) scale(1)}}
@keyframes camera-save{0%,7%{transform:translate(-360px,-135px) scale(1)}20%,36%{transform:translate(-360px,-340px) scale(1)}46%,92%{transform:translate(-430px,-390px) scale(1)}100%{transform:translate(-360px,-135px) scale(1)}}
@keyframes camera-modal-appear{0%,24%{opacity:0;transform:scale(.96) translateY(10px)}38%,94%{opacity:1;transform:none}100%{opacity:0;transform:scale(.96) translateY(10px)}}
@keyframes camera-app-click{0%,11%,30%,100%{border-color:var(--camera-line)}16%,23%{border-color:var(--camera-accent);background:color-mix(in srgb,var(--camera-accent) 13%,var(--camera-field))}}
@keyframes camera-open-pointer{0%,7%,27%,100%{opacity:0;transform:translate(12px,9px)}14%,20%{opacity:1;transform:none}}
@media(max-width:700px){
  .settings-camera{height:350px}
  .camera-canvas{width:900px}
  .settings-modal{width:770px;grid-template-columns:180px minmax(0,1fr)}
  .modal-tabs nav{padding:12px}.modal-title{padding:17px 13px}.modal-scroll{padding:33px 23px 16px}.modal-footer{padding-inline:22px}
  .focus-open .camera-canvas{animation-name:camera-open-mobile}
  .focus-provider .camera-canvas,.focus-select .camera-canvas{animation-name:camera-provider-mobile}
  .focus-headers .camera-canvas{animation-name:camera-headers-mobile}
  .focus-check .camera-canvas{animation-name:camera-check-mobile}
  .focus-model .camera-canvas{animation-name:camera-model-mobile}
  .focus-prepare .camera-canvas{animation-name:camera-prepare-mobile}
  .focus-save .camera-canvas{animation-name:camera-save-mobile}
}
/* Narrow viewports follow the control across the larger modal instead of fitting the whole form. */
@keyframes camera-open-mobile{0%,24%{transform:translate(12px,-480px) scale(.85)}58%,92%{transform:translate(-275px,-5px) scale(.85)}100%{transform:translate(12px,-480px) scale(.85)}}
@keyframes camera-provider-mobile{0%,7%{transform:translate(-275px,-5px) scale(.85)}16%,23%{transform:translate(var(--right-field),-5px) scale(.85)}26%,44%{transform:translate(-275px,-5px) scale(.85)}55%,70%{transform:translate(var(--right-field),-85px) scale(.85)}86%,92%{transform:translate(-275px,-85px) scale(.85)}100%{transform:translate(-275px,-5px) scale(.85)}}
@keyframes camera-headers-mobile{0%,7%{transform:translate(-275px,-85px) scale(.85)}17%,27%{transform:translate(var(--right-field),-210px) scale(.85)}41%,55%{transform:translate(-275px,-210px) scale(.85)}67%,74%{transform:translate(var(--right-field),-210px) scale(.85)}82%,92%{transform:translate(-275px,-210px) scale(.85)}100%{transform:translate(-275px,-85px) scale(.85)}}
@keyframes camera-check-mobile{0%,7%{transform:translate(-275px,-210px) scale(.85)}13%,92%{transform:translate(var(--right-field),-120px) scale(.85)}100%{transform:translate(-275px,-210px) scale(.85)}}
@keyframes camera-model-mobile{0%,7%{transform:translate(var(--right-field),-120px) scale(.85)}16%,58%{transform:translate(-275px,-300px) scale(.85)}68%,92%{transform:translate(var(--right-save),-300px) scale(.85)}100%{transform:translate(var(--right-field),-120px) scale(.85)}}
@keyframes camera-select-mobile{0%,7%{transform:translate(-275px,-5px) scale(.85)}16%,23%{transform:translate(var(--right-field),-5px) scale(.85)}26%,44%{transform:translate(-275px,-5px) scale(.85)}55%,92%{transform:translate(-275px,-60px) scale(.85)}100%{transform:translate(-275px,-5px) scale(.85)}}
@keyframes camera-prepare-mobile{0%,7%{transform:translate(-275px,-60px) scale(.85)}15%,23%{transform:translate(var(--right-field),-60px) scale(.85)}33%,92%{transform:translate(-275px,-75px) scale(.85)}100%{transform:translate(-275px,-60px) scale(.85)}}
@keyframes camera-save-mobile{0%,7%{transform:translate(-275px,-75px) scale(.85)}20%,36%{transform:translate(-275px,-235px) scale(.85)}46%,92%{transform:translate(var(--right-save),-300px) scale(.85)}100%{transform:translate(-275px,-75px) scale(.85)}}
.focus-select .camera-canvas{animation-name:camera-select}
@keyframes camera-select{0%,7%{transform:translate(-140px,-7px) scale(.92)}16%,92%{transform:translate(-360px,-50px) scale(1)}100%{transform:translate(-140px,-7px) scale(.92)}}
@media(max-width:700px){.focus-select .camera-canvas{animation-name:camera-select-mobile}}
html:has(#docs-pause-motion:checked) .camera-canvas,html:has(#docs-pause-motion:checked) .settings-modal,html:has(#docs-pause-motion:checked) .app-settings,html:has(#docs-pause-motion:checked) .app-pointer{animation:none!important}
html:has(#docs-pause-motion:checked) .settings-modal{opacity:1;transform:none}
html:has(#docs-pause-motion:checked) .app-pointer{display:none}
html:has(#docs-pause-motion:checked) .focus-open .camera-canvas{transform:translate(-140px,-7px) scale(.92)}
html:has(#docs-pause-motion:checked) .focus-provider .camera-canvas,html:has(#docs-pause-motion:checked) .focus-select .camera-canvas{transform:translate(-360px,-50px) scale(1)}
html:has(#docs-pause-motion:checked) .focus-headers .camera-canvas{transform:translate(-360px,-280px) scale(1)}
html:has(#docs-pause-motion:checked) .focus-check .camera-canvas{transform:translate(-360px,-170px) scale(1)}
html:has(#docs-pause-motion:checked) .focus-model .camera-canvas{transform:translate(-430px,-414px) scale(1)}
html:has(#docs-pause-motion:checked) .focus-save .camera-canvas{transform:translate(-430px,-390px) scale(1)}
html:has(#docs-pause-motion:checked) .focus-prepare .camera-canvas{transform:translate(-360px,-135px) scale(1)}
@media(max-width:700px){
  html:has(#docs-pause-motion:checked) .focus-open .camera-canvas{transform:translate(-275px,-5px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-provider .camera-canvas{transform:translate(-275px,-85px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-select .camera-canvas{transform:translate(-275px,-60px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-headers .camera-canvas{transform:translate(-275px,-210px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-check .camera-canvas{transform:translate(var(--right-field),-120px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-model .camera-canvas{transform:translate(var(--right-save),-300px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-save .camera-canvas{transform:translate(var(--right-save),-300px) scale(.85)}
  html:has(#docs-pause-motion:checked) .focus-prepare .camera-canvas{transform:translate(-275px,-75px) scale(.85)}
}
@media(prefers-reduced-motion:reduce){
  .camera-canvas,.settings-modal,.app-settings,.app-pointer{animation:none!important}.settings-modal{opacity:1;transform:none}.app-pointer{display:none}
  .focus-open .camera-canvas{transform:translate(-140px,-7px) scale(.92)}
  .focus-provider .camera-canvas,.focus-select .camera-canvas{transform:translate(-360px,-50px) scale(1)}
  .focus-headers .camera-canvas{transform:translate(-360px,-280px) scale(1)}
  .focus-check .camera-canvas{transform:translate(-360px,-170px) scale(1)}
  .focus-model .camera-canvas{transform:translate(-430px,-414px) scale(1)}
  .focus-save .camera-canvas{transform:translate(-430px,-390px) scale(1)}
  .focus-prepare .camera-canvas{transform:translate(-360px,-135px) scale(1)}
}
@media(max-width:700px) and (prefers-reduced-motion:reduce){
  .focus-open .camera-canvas{transform:translate(-275px,-5px) scale(.85)}
  .focus-provider .camera-canvas{transform:translate(-275px,-85px) scale(.85)}
  .focus-select .camera-canvas{transform:translate(-275px,-60px) scale(.85)}
  .focus-headers .camera-canvas{transform:translate(-275px,-210px) scale(.85)}
  .focus-check .camera-canvas{transform:translate(var(--right-field),-120px) scale(.85)}
  .focus-model .camera-canvas{transform:translate(var(--right-save),-300px) scale(.85)}
  .focus-save .camera-canvas{transform:translate(var(--right-save),-300px) scale(.85)}
  .focus-prepare .camera-canvas{transform:translate(-275px,-75px) scale(.85)}
}
</style>
