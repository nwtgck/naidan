<script setup lang="ts">
import { BookmarkPlusIcon, GlobeIcon, MousePointer2Icon, Settings2Icon, SettingsIcon, SquarePenIcon, WrenchIcon, XIcon } from 'lucide-vue-next';

defineProps<{
  focus: 'open' | 'provider' | 'headers' | 'check' | 'model' | 'select' | 'prepare' | 'save',
  animationId: string,
  testId: string,
  messages: Readonly<{ new_chat: string; settings: string; connection: string; tools: string; provider_profiles: string }>,
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="settings-camera" :class="`focus-${focus}`" :data-docs-animation="animationId" :data-testid="testId" aria-hidden="true">
    <div class="camera-canvas">
      <aside class="app-rail">
        <strong>Naidan</strong>
        <div class="app-new-chat"><SquarePenIcon :size="16" />{{ messages.new_chat }}</div>
        <div class="app-settings"><SettingsIcon :size="17" />{{ messages.settings }}<MousePointer2Icon v-if="focus === 'open'" class="app-pointer" :size="25" /></div>
      </aside>
      <div class="app-backdrop" />
      <div class="settings-modal">
        <aside class="modal-tabs">
          <div class="modal-title"><span class="modal-title-icon"><Settings2Icon :size="19" /></span><strong>{{ messages.settings }}</strong></div>
          <nav>
            <div class="tab selected"><GlobeIcon :size="17" />{{ messages.connection }}</div>
            <div class="tab"><WrenchIcon :size="17" />{{ messages.tools }}</div>
            <div class="tab"><BookmarkPlusIcon :size="17" />{{ messages.provider_profiles }}</div>
            <div class="nav-divider" />
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
.settings-camera {
  --camera-bg:var(--bg);
  --camera-panel:var(--surface);
  --camera-field:var(--surface-2);
  --camera-line:var(--line-strong);
  --camera-ink:var(--text);
  --camera-muted:var(--muted);
  --camera-accent:var(--blue);
  --field-x:-400px;
  --model-x:min(-400px, calc(100cqw - 1080px));
  --save-x:calc(100cqw - 1120px);
  --rest-x:var(--field-x);
  --rest-y:-50px;
  --rest-scale:1;
  --step-duration:9s;
  container-type: inline-size;
  position: relative;
  width: 100%;
  max-width: 680px;
  height: 350px;
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid var(--camera-line);
  border-radius: 15px;
  background: var(--camera-bg);
  box-shadow: var(--panel-shadow);
  color: var(--camera-ink);
  font: 14px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.camera-canvas {
  position: absolute;
  left: 0;
  top: 0;
  width: 1120px;
  height: 800px;
  transform-origin: top left;
}
.app-rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 205px;
  padding: 24px 16px;
  background: var(--camera-panel);
  border-right: 1px solid var(--camera-line);
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.app-rail strong {
  font-size: 22px;
  letter-spacing: -.04em;
}
.app-new-chat,.app-settings {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  font-weight: 700;
}
.app-new-chat {
  color: var(--camera-muted);
  background: var(--camera-field);
}
.app-settings {
  position: relative;
  margin-top: auto;
  border: 1px solid var(--camera-line);
  background: var(--camera-field);
}
.focus-open .app-settings {
  animation: camera-app-click 8s linear infinite;
}
.app-pointer {
  position: absolute;
  right: 8px;
  bottom: -11px;
  fill: var(--camera-panel);
  filter: drop-shadow(0 2px 3px #0009);
  animation: camera-open-pointer 8s linear infinite;
}
.app-backdrop {
  position: absolute;
  left: 205px;
  top: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(160deg,var(--camera-bg),var(--camera-field));
}
.settings-modal {
  position: absolute;
  left: 150px;
  top: 28px;
  width: 970px;
  height: 714px;
  display: grid;
  grid-template-columns: 230px minmax(0,1fr);
  border: 1px solid var(--camera-line);
  border-radius: 22px;
  background: var(--camera-panel);
  box-shadow: 0 24px 70px #0007;
  overflow: hidden;
}
.focus-open .settings-modal {
  animation: camera-modal-appear 8s ease-in-out infinite;
}
.modal-tabs {
  display: flex;
  flex-direction: column;
  background: var(--camera-field);
  border-right: 1px solid var(--camera-line);
}
.modal-title {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 21px 17px;
  border-bottom: 1px solid var(--camera-line);
  font-size: 18px;
}
.modal-title-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--camera-line);
  border-radius: 10px;
  background: var(--camera-panel);
  color: var(--camera-accent);
}
.modal-tabs nav {
  display: grid;
  align-content: start;
  gap: 7px;
  padding: 15px;
}
.tab {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  border: 1px solid transparent;
  border-radius: 11px;
  color: var(--camera-muted);
  font-weight: 700;
}
.tab.selected {
  background: var(--camera-panel);
  border-color: var(--camera-line);
  box-shadow: 0 5px 14px #0001;
  color: var(--camera-accent);
}
.modal-main {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--camera-panel);
}
.modal-close {
  position: absolute;
  z-index: 2;
  right: 15px;
  top: 14px;
  color: var(--camera-muted);
}
.modal-scroll {
  flex: 1;
  min-height: 0;
  padding: 38px 45px 20px;
  overflow: hidden;
}
.modal-footer {
  min-height: 74px;
  padding: 14px 35px;
  border-top: 1px solid var(--camera-line);
  background: var(--camera-field);
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
}

.nav-divider {
  margin-top: 8px;
  border-top: 1px solid var(--camera-line);
}
.focus-open {
  --rest-x:-140px;
  --rest-y:-7px;
  --rest-scale:.92;
}
.focus-headers {
  --rest-y:-230px;
}
.focus-check {
  --rest-y:-95px;
}
.focus-prepare {
  --rest-y:-125px;
  --step-duration:10s;
}
.focus-model {
  --step-duration:10s;
}
.focus-model,.focus-save {
  --rest-x:var(--save-x);
  --rest-y:-410px;
}
.focus-open .camera-canvas {
  animation: camera-open 8s ease-in-out infinite;
}
.focus-provider .camera-canvas,.focus-select .camera-canvas,.focus-headers .camera-canvas,.focus-check .camera-canvas,.focus-prepare .camera-canvas {
  animation: camera-field var(--step-duration) ease-in-out infinite;
}
.focus-model .camera-canvas {
  animation: camera-model 10s ease-in-out infinite;
}
.focus-save .camera-canvas {
  animation: camera-model 9s ease-in-out infinite;
}
@keyframes camera-open {
  0%,24%,100% {
    transform: translate(15px,-480px) scale(.85);
  }
  58%,92% {
    transform: translate(var(--rest-x),var(--rest-y)) scale(var(--rest-scale));
  }
}
@keyframes camera-field {
  0%,7%,100% {
    transform: translate(var(--field-x),-5px);
  }
  18%,92% {
    transform: translate(var(--rest-x),var(--rest-y));
  }
}
@keyframes camera-model {
  0%,7%,100% {
    transform: translate(var(--field-x),-95px);
  }
  18%,57% {
    transform: translate(var(--model-x),-50px);
  }
  70%,92% {
    transform: translate(var(--save-x),-410px);
  }
}
@keyframes camera-modal-appear {
  0%,24%,100% {
    opacity: 0;
    transform: scale(.96) translateY(10px);
  }
  38%,94% {
    opacity: 1;
    transform: none;
  }
}
@keyframes camera-app-click {
  0%,11%,30%,100% {
    border-color: var(--camera-line);
  }
  16%,23% {
    border-color: var(--camera-accent);
    background: color-mix(in srgb,var(--camera-accent) 13%,var(--camera-field));
  }
}
@keyframes camera-open-pointer {
  0%,7%,27%,100% {
    opacity: 0;
    transform: translate(12px,9px);
  }
  14%,20% {
    opacity: 1;
    transform: none;
  }
}
@media(max-width:700px) {
  .settings-camera {
    --field-x:-330px;
    --model-x:min(-330px, calc(100cqw - 910px));
    --save-x:calc(100cqw - 920px);
  }
  .camera-canvas {
    width: 900px;
  }
  .settings-modal {
    width: 770px;
    grid-template-columns: 180px minmax(0,1fr);
  }
  .modal-tabs nav {
    padding: 12px;
  }
  .modal-title {
    padding: 17px 13px;
  }
  .modal-scroll {
    padding: 33px 23px 16px;
  }
  .modal-footer {
    padding-inline: 22px;
  }
  .focus-open {
    --rest-x:-275px;
    --rest-y:-5px;
    --rest-scale:.85;
  }
}
html:has(#docs-pause-motion:checked) .camera-canvas,
html:has(#docs-pause-motion:checked) .settings-modal,
html:has(#docs-pause-motion:checked) .app-settings,
html:has(#docs-pause-motion:checked) .app-pointer {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .camera-canvas {
  transform: translate(var(--rest-x),var(--rest-y)) scale(var(--rest-scale));
}
html:has(#docs-pause-motion:checked) .settings-modal {
  opacity: 1;
  transform: none;
}
html:has(#docs-pause-motion:checked) .app-pointer {
  display: none;
}
@media(prefers-reduced-motion:reduce) {
  .camera-canvas,.settings-modal,.app-settings,.app-pointer {
    animation: none!important;
  }
  .camera-canvas {
    transform: translate(var(--rest-x),var(--rest-y)) scale(var(--rest-scale));
  }
  .settings-modal {
    opacity: 1;
    transform: none;
  }
  .app-pointer {
    display: none;
  }
}

.settings-camera {
  --field:var(--surface-2);
  --panel:var(--surface);
  --line:var(--line-strong);
  --ink:var(--text);
  --accent:var(--blue);
  font: 14px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.settings-camera :deep(.guide-content) {
  width: 100%;
  color: var(--ink);
}
.settings-camera :deep(.connection-toolbar) {
  display: flex;
  justify-content: flex-end;
  min-height: 32px;
  margin-bottom: 22px;
}
.settings-camera :deep(.copy-url) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 11px;
}
.settings-camera :deep(.connection-layout) {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1fr);
  grid-template-areas: "provider model" "details model";
  align-items: start;
  gap: 20px;
}
.settings-camera :deep(.provider-field) {
  grid-area: provider;
}
.settings-camera :deep(.model-section) {
  grid-area: model;
}
.settings-camera :deep(.connection-details) {
  grid-area: details;
  display: grid;
  gap: 16px;
}
.settings-camera :deep(.field) {
  position: relative;
  display: grid;
  min-width: 0;
  gap: 8px;
}
.settings-camera :deep(.field-label) {
  color: var(--ink);
  font-size: 12px;
  font-weight: 650;
}
.settings-camera :deep(.field-box) {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--panel);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.settings-camera :deep(.field-box>svg) {
  flex: none;
  color: var(--muted);
}
.settings-camera :deep(.layered) {
  display: grid;
  min-width: 0;
}
.settings-camera :deep(.layered>span) {
  grid-area: 1/1;
  overflow-wrap: anywhere;
}
.settings-camera :deep(.provider-after),.settings-camera :deep(.url-after),.settings-camera :deep(.model-after) {
  opacity: 0;
}
.settings-camera.focus-provider :deep(.provider-before),.settings-camera.focus-select :deep(.provider-before) {
  animation: before-choice 9s linear infinite;
}
.settings-camera.focus-provider :deep(.provider-after),.settings-camera.focus-select :deep(.provider-after) {
  animation: after-choice 9s linear infinite;
}
.settings-camera.focus-provider :deep(.url-before) {
  animation: before-url 9s linear infinite;
}
.settings-camera.focus-provider :deep(.url-after) {
  animation: after-url 9s linear infinite;
}
.settings-camera.focus-headers :deep(.provider-before),.settings-camera.focus-check :deep(.provider-before),.settings-camera.focus-model :deep(.provider-before),.settings-camera.focus-prepare :deep(.provider-before),.settings-camera.focus-save :deep(.provider-before),.settings-camera.focus-headers :deep(.url-before),.settings-camera.focus-check :deep(.url-before),.settings-camera.focus-model :deep(.url-before) {
  opacity: 0;
}
.settings-camera.focus-headers :deep(.provider-after),.settings-camera.focus-check :deep(.provider-after),.settings-camera.focus-model :deep(.provider-after),.settings-camera.focus-prepare :deep(.provider-after),.settings-camera.focus-save :deep(.provider-after),.settings-camera.focus-headers :deep(.url-after),.settings-camera.focus-check :deep(.url-after),.settings-camera.focus-model :deep(.url-after) {
  opacity: 1;
}
.settings-camera :deep(.provider-options),.settings-camera :deep(.model-options) {
  position: absolute;
  z-index: 4;
  top: 100%;
  inset-inline: 0;
  display: grid;
  gap: 3px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--panel);
  box-shadow: 0 14px 30px #0003;
  opacity: 0;
  animation: choice-menu 9s linear infinite;
}
.settings-camera :deep(.provider-options>span),.settings-camera :deep(.model-option) {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  padding: 8px;
  border-radius: 7px;
  font-size: 12px;
}
.settings-camera :deep(.provider-option-target),.settings-camera :deep(.model-option-target) {
  color: var(--accent);
  background: color-mix(in srgb,var(--accent) 10%,var(--panel));
}
.settings-camera :deep(.presets) {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.settings-camera :deep(.preset) {
  position: relative;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.settings-camera.focus-provider :deep(.target-preset) {
  animation: preset-focus 9s linear infinite;
}
.settings-camera :deep(.field-heading) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.settings-camera :deep(.url-box) {
  font: 11px/1.5 ui-monospace,SFMono-Regular,monospace;
}
.settings-camera :deep(.check-action),.settings-camera :deep(.save-action) {
  position: relative;
  display: grid;
}
.settings-camera :deep(.check-action>span),.settings-camera :deep(.save-action>span) {
  grid-area: 1/1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.settings-camera :deep(.check-action) {
  min-height: 32px;
  font-size: 10px;
  color: var(--accent);
  white-space: nowrap;
}
.settings-camera :deep(.check-loading),.settings-camera :deep(.check-done),.settings-camera :deep(.save-done) {
  opacity: 0;
}
.settings-camera :deep(.check-done>svg) {
  color: var(--green);
}
.settings-camera.focus-check :deep(.check-idle) {
  animation: check-idle 9s linear infinite;
}
.settings-camera.focus-check :deep(.check-loading) {
  animation: check-loading 9s linear infinite;
}
.settings-camera.focus-check :deep(.check-done) {
  animation: check-done 9s linear infinite;
}
.settings-camera :deep(.auto-hint),.settings-camera :deep(.model-section small) {
  margin: 0;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.7;
}
.settings-camera :deep(.headers-disclosure) {
  position: relative;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.settings-camera :deep(.headers-heading) {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  color: var(--ink);
  font-size: 12px;
}
.settings-camera :deep(.header-count) {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}
.settings-camera :deep(.header-details) {
  display: none;
  padding-bottom: 12px;
}
.settings-camera.focus-headers :deep(.header-details) {
  display: grid;
  gap: 10px;
}
.settings-camera :deep(.header-after) {
  opacity: 0;
}
.settings-camera.focus-headers :deep(.header-details) {
  animation: header-details 9s linear infinite;
}
.settings-camera.focus-headers :deep(.header-row),.settings-camera.focus-headers :deep(.header-after) {
  animation: header-after 9s linear infinite;
}
.settings-camera.focus-headers :deep(.header-before) {
  animation: header-before 9s linear infinite;
}
.settings-camera :deep(.add-pointer) {
  animation: point-add 9s linear infinite;
}
.settings-camera :deep(.header-row) {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1fr) 16px;
  gap: 7px;
  align-items: center;
}
.settings-camera :deep(.header-row>span) {
  min-width: 0;
  padding: 9px 7px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  font: 10px/1.5 ui-monospace,SFMono-Regular,monospace;
  overflow-wrap: anywhere;
}
.settings-camera :deep(.add-header) {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  font-size: 11px;
}
.settings-camera :deep(.model-picker) {
  position: relative;
  min-width: 0;
}
.settings-camera :deep(.model-options) {
  animation: model-menu 10s linear infinite;
}
.settings-camera :deep(.model-options-tools) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: 10px;
}
.settings-camera :deep(.model-search) {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 4px;
  min-width: 0;
}
.settings-camera :deep(.model-option-target) {
  font-weight: 650;
}
.settings-camera.focus-model :deep(.model-before) {
  animation: before-model 10s linear infinite;
}
.settings-camera.focus-model :deep(.model-after) {
  animation: after-model 10s linear infinite;
}
.settings-camera :deep(.secondary-save) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  color: var(--muted);
  font-size: 11px;
}
.settings-camera :deep(.save-action>span) {
  min-height: 42px;
  padding: 10px 18px;
  border: 1px solid #1d4ed8;
  border-radius: 10px;
  background: #2563eb;
  color: white;
  font-size: 12px;
  white-space: nowrap;
}
.settings-camera.focus-model :deep(.save-idle),.settings-camera.focus-save :deep(.save-idle) {
  animation: before-save var(--step-duration) linear infinite;
}
.settings-camera.focus-model :deep(.save-done),.settings-camera.focus-save :deep(.save-done) {
  animation: after-save var(--step-duration) linear infinite;
}
.settings-camera :deep(.pointer) {
  position: absolute;
  z-index: 5;
  right: 5px;
  bottom: -11px;
  color: var(--ink);
  fill: var(--panel);
  filter: drop-shadow(0 2px 3px #0006);
  opacity: 0;
  pointer-events: none;
}
.settings-camera :deep(.provider-pointer) {
  animation: point-provider var(--step-duration) linear infinite;
}
.settings-camera :deep(.option-pointer) {
  animation: point-option 9s linear infinite;
}
.settings-camera :deep(.preset-pointer) {
  animation: point-preset 9s linear infinite;
}
.settings-camera :deep(.header-pointer) {
  animation: point-option 9s linear infinite;
}
.settings-camera :deep(.check-pointer) {
  animation: point-provider var(--step-duration) linear infinite;
}
.settings-camera :deep(.model-pointer),.settings-camera :deep(.model-option-pointer) {
  animation: point-model 10s linear infinite;
}
.settings-camera :deep(.save-pointer) {
  animation: point-save var(--step-duration) linear infinite;
}
.settings-camera :deep(.spinner) {
  animation: spinner .7s linear infinite;
}
@keyframes before-choice {
  0%,23%,100% {
    opacity: 1;
  }
  35%,92% {
    opacity: 0;
  }
}
@keyframes after-choice {
  0%,23%,100% {
    opacity: 0;
  }
  35%,92% {
    opacity: 1;
  }
}
@keyframes before-url {
  0%,49%,100% {
    opacity: 1;
  }
  62%,92% {
    opacity: 0;
  }
}
@keyframes after-url {
  0%,49%,100% {
    opacity: 0;
  }
  62%,92% {
    opacity: 1;
  }
}
@keyframes choice-menu {
  0%,20%,36%,100% {
    opacity: 0;
  }
  24%,33% {
    opacity: 1;
  }
}
@keyframes preset-focus {
  0%,49%,100% {
    border-color: var(--line);
  }
  62%,92% {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb,var(--accent) 10%,var(--panel));
  }
}
@keyframes check-idle {
  0%,24%,100% {
    opacity: 1;
  }
  30%,92% {
    opacity: 0;
  }
}
@keyframes check-loading {
  0%,25%,67%,100% {
    opacity: 0;
  }
  32%,60% {
    opacity: 1;
  }
}
@keyframes check-done {
  0%,65%,100% {
    opacity: 0;
  }
  72%,92% {
    opacity: 1;
  }
}
@keyframes model-menu {
  0%,24%,53%,100% {
    opacity: 0;
  }
  30%,48% {
    opacity: 1;
  }
}
@keyframes before-model {
  0%,46%,100% {
    opacity: 1;
  }
  56%,92% {
    opacity: 0;
  }
}
@keyframes after-model {
  0%,46%,100% {
    opacity: 0;
  }
  56%,92% {
    opacity: 1;
  }
}
@keyframes before-save {
  0%,76%,100% {
    opacity: 1;
  }
  84%,92% {
    opacity: 0;
  }
}
@keyframes after-save {
  0%,76%,100% {
    opacity: 0;
  }
  84%,92% {
    opacity: 1;
  }
}
@keyframes point-provider {
  0%,12%,30%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  18%,25% {
    opacity: 1;
    transform: none;
  }
}
@keyframes point-option {
  0%,24%,39%,100% {
    opacity: 0;
  }
  28%,34% {
    opacity: 1;
  }
}
@keyframes point-preset {
  0%,48%,68%,100% {
    opacity: 0;
  }
  54%,62% {
    opacity: 1;
  }
}
@keyframes point-model {
  0%,26%,52%,100% {
    opacity: 0;
  }
  32%,46% {
    opacity: 1;
  }
}
@keyframes point-save {
  0%,69%,88%,100% {
    opacity: 0;
  }
  75%,82% {
    opacity: 1;
  }
}
@keyframes spinner {
  to {
    transform: rotate(360deg);
  }
}
html:has(#docs-pause-motion:checked) .settings-camera :deep(*) {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .settings-camera.focus-provider :deep(.provider-before),html:has(#docs-pause-motion:checked) .settings-camera.focus-provider :deep(.url-before),html:has(#docs-pause-motion:checked) .settings-camera.focus-select :deep(.provider-before),html:has(#docs-pause-motion:checked) .settings-camera.focus-check :deep(.check-idle),html:has(#docs-pause-motion:checked) .settings-camera.focus-check :deep(.check-loading),html:has(#docs-pause-motion:checked) .settings-camera.focus-model :deep(.model-before),html:has(#docs-pause-motion:checked) .settings-camera.focus-model :deep(.save-idle),html:has(#docs-pause-motion:checked) .settings-camera.focus-save :deep(.save-idle) {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .settings-camera.focus-provider :deep(.provider-after),html:has(#docs-pause-motion:checked) .settings-camera.focus-provider :deep(.url-after),html:has(#docs-pause-motion:checked) .settings-camera.focus-select :deep(.provider-after),html:has(#docs-pause-motion:checked) .settings-camera.focus-check :deep(.check-done),html:has(#docs-pause-motion:checked) .settings-camera.focus-model :deep(.model-after),html:has(#docs-pause-motion:checked) .settings-camera.focus-model :deep(.save-done),html:has(#docs-pause-motion:checked) .settings-camera.focus-save :deep(.save-done) {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .settings-camera :deep(.provider-options),html:has(#docs-pause-motion:checked) .settings-camera :deep(.model-options),html:has(#docs-pause-motion:checked) .settings-camera :deep(.pointer) {
  display: none;
}
@media(prefers-reduced-motion:reduce) {
  .settings-camera :deep(*) {
    animation: none!important;
  }
  .settings-camera.focus-provider :deep(.provider-before),.settings-camera.focus-provider :deep(.url-before),.settings-camera.focus-select :deep(.provider-before),.settings-camera.focus-check :deep(.check-idle),.settings-camera.focus-check :deep(.check-loading),.settings-camera.focus-model :deep(.model-before),.settings-camera.focus-model :deep(.save-idle),.settings-camera.focus-save :deep(.save-idle) {
    opacity: 0;
  }
  .settings-camera.focus-provider :deep(.provider-after),.settings-camera.focus-provider :deep(.url-after),.settings-camera.focus-select :deep(.provider-after),.settings-camera.focus-check :deep(.check-done),.settings-camera.focus-model :deep(.model-after),.settings-camera.focus-model :deep(.save-done),.settings-camera.focus-save :deep(.save-done) {
    opacity: 1;
  }
  .settings-camera :deep(.provider-options),.settings-camera :deep(.model-options),.settings-camera :deep(.pointer) {
    display: none;
  }
}

@keyframes header-details {
  0%,25%,100% {
    opacity: 0;
  }
  35%,92% {
    opacity: 1;
  }
}
@keyframes header-before {
  0%,48%,100% {
    opacity: 1;
  }
  56%,92% {
    opacity: 0;
  }
}
@keyframes header-after {
  0%,48%,100% {
    opacity: 0;
  }
  56%,92% {
    opacity: 1;
  }
}
@keyframes point-add {
  0%,39%,56%,100% {
    opacity: 0;
  }
  45%,52% {
    opacity: 1;
  }
}
html:has(#docs-pause-motion:checked) .settings-camera.focus-headers :deep(.header-before) {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .settings-camera.focus-headers :deep(.header-details),html:has(#docs-pause-motion:checked) .settings-camera.focus-headers :deep(.header-row),html:has(#docs-pause-motion:checked) .settings-camera.focus-headers :deep(.header-after) {
  opacity: 1;
}
@media(prefers-reduced-motion:reduce) {
  .settings-camera.focus-headers :deep(.header-before) {
    opacity: 0;
  }
  .settings-camera.focus-headers :deep(.header-details),.settings-camera.focus-headers :deep(.header-row),.settings-camera.focus-headers :deep(.header-after) {
    opacity: 1;
  }
}
</style>
