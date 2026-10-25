<script setup lang="ts">
import { BookOpenIcon, CalculatorIcon, InfoIcon, ListIcon, MousePointer2Icon, PanelLeftIcon, Settings2Icon, TerminalIcon } from 'lucide-vue-next';
import NaidanChatInput from './NaidanChatInput.vue';
import type { CommonMessages } from '../../messages/types';

defineProps<{
  stage: 'open' | 'enable',
  messages: typeof import('../../pages/tool-browser-shell/messages/en').messages,
  common: CommonMessages,
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div
    class="shell-enable-camera"
    :class="`stage-${stage}`"
    :data-docs-animation="`shell-enable-${stage}`"
    :data-testid="`docs-shell-enable-${stage}`"
    aria-hidden="true"
  >
    <div v-if="stage === 'open'" class="chat-scene">
      <header class="chat-header"><PanelLeftIcon :size="16" /><strong>{{ messages.tool_settings_chat_title }}</strong><Settings2Icon :size="16" /></header>
      <div class="conversation-space" />
      <!-- Omit the model source badge to keep this scene focused on enabling Shell. -->
      <NaidanChatInput class="chat-composer" :messages="common" :model="messages.sample_model">
        <template #tools><MousePointer2Icon class="open-pointer" data-testid="docs-shell-open-pointer" :size="25" /></template>
      </NaidanChatInput>
      <div class="sheet-backdrop" />
      <div class="tools-sheet" data-testid="docs-shell-tools-sheet">
        <div class="sheet-handle"><i /></div>
        <div class="sheet-title">{{ messages.options_tools_sheet }}</div>
        <div class="tool-session-note"><InfoIcon :size="12" /><span>{{ messages.tool_session_notice }}</span></div>
        <div class="tools-grid">
          <div class="tool-preview"><CalculatorIcon :size="16" /><strong>{{ messages.calculator_tool }}</strong><span class="preview-switch">{{ messages.off_status }}<i /></span></div>
          <div class="tool-preview"><ListIcon :size="16" /><strong>{{ messages.choices_tool }}</strong><span class="preview-switch">{{ messages.off_status }}<i /></span></div>
          <div class="tool-preview"><BookOpenIcon :size="16" /><strong>{{ messages.wikipedia_tool }}</strong><span class="preview-switch">{{ messages.off_status }}<i /></span></div>
          <div class="tool-preview"><TerminalIcon :size="16" /><strong>{{ messages.shell_tool_label }}</strong><span class="preview-switch">{{ messages.off_status }}<i /></span></div>
        </div>
      </div>
    </div>

    <div v-else class="tool-scene">
      <div class="tool-sheet-handle"><i /></div>
      <div class="shell-tool-card" data-testid="docs-shell-switch-card">
        <span class="shell-tool-icon"><TerminalIcon :size="18" /></span>
        <span class="shell-tool-name"><strong>{{ messages.shell_tool_label }}</strong><small>{{ messages.shell_tool_description }}</small></span>
        <span class="tool-inherit">{{ messages.inherit_global_label }}</span>
        <span class="shell-switch" data-testid="docs-shell-switch"><span class="switch-off">{{ messages.off_status }}</span><span class="switch-on">{{ messages.on_status }}</span><i /><MousePointer2Icon class="switch-pointer" :size="25" /></span>
      </div>
      <div class="shell-settings-panel" data-testid="docs-shell-settings-result">
        <div class="shell-settings-heading"><strong>{{ messages.shell_settings_label }}</strong></div>
        <div class="mount-row"><span>{{ messages.mount_label }} <code>/sys/fs/naidan</code></span><span class="mount-switch"><i /></span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell-enable-camera {
  position: relative;
  width: 100%;
  max-width: 620px;
  height: 268px;
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--bg);
  box-shadow: 0 18px 46px #0003;
  color: var(--text);
  font: 12px/1.5 ui-sans-serif, system-ui, sans-serif;
  text-align: left;
}
.chat-scene,.tool-scene {
  position: absolute;
  inset: 0;
}
.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 15px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--muted);
}
.chat-header strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 12px;
}
.conversation-space {
  position: absolute;
  inset: 45px 0 0;
  background: linear-gradient(180deg,var(--bg),var(--surface));
}
.shell-enable-camera .chat-composer {
  --chat-input-control-size:30px;
  --chat-input-font-size:11px;
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 12px;
}
.chat-composer :deep([data-testid="docs-chat-input-tools"]) {
  animation: tools-trigger 8s ease-in-out infinite;
}
.open-pointer {
  position: absolute;
  left: 22px;
  top: 18px;
  z-index: 4;
  color: var(--text);
  fill: var(--bg);
  filter: drop-shadow(0 2px 2px #000);
  animation: open-pointer 8s ease-in-out infinite;
}
.sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: #0007;
  animation: sheet-shade 8s ease-in-out infinite;
}
.tools-sheet {
  position: absolute;
  z-index: 6;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 198px;
  border: 1px solid var(--line-strong);
  border-radius: 16px 16px 0 0;
  background: var(--surface-2);
  box-shadow: 0 -9px 25px #0004;
  overflow: hidden;
  animation: open-sheet 8s cubic-bezier(.18,.82,.2,1) infinite;
}
.sheet-handle,.tool-sheet-handle {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 15px;
}
.sheet-handle i,.tool-sheet-handle i {
  display: block;
  width: 42px;
  height: 4px;
  border-radius: 99px;
  background: var(--subtle);
}
.sheet-title {
  padding: 7px 18px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--muted);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.tool-session-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 12px;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.4;
}
.tool-session-note svg {
  flex: none;
}
.tools-grid {
  display: grid;
  grid-template-columns: repeat(2,minmax(0,1fr));
  gap: 7px;
  padding: 0 12px 12px;
}
.tool-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 43px;
  padding: 7px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--muted);
}
.tool-preview>svg {
  flex: none;
}
.tool-preview strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}
.preview-switch {
  position: relative;
  width: 40px;
  height: 20px;
  flex: none;
  padding: 4px 4px 0 0;
  border-radius: 99px;
  background: #4b5563;
  color: white;
  text-align: right;
  font-size: 7px;
  font-weight: 900;
}
.preview-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
}
.tool-inherit {
  flex: none;
  padding: 3px 5px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  font-size: 8px;
  opacity: 0;
  animation: show-on 8s linear infinite;
}

.tool-scene {
  background: var(--surface-2);
  padding: 0 18px;
}
.tool-sheet-handle {
  height: 20px;
}
.shell-tool-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 390px;
  height: 66px;
  margin: 20px auto 0;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-2);
  animation: enable-card 8s linear infinite;
}
.shell-tool-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--bg);
  color: var(--muted);
  animation: enable-icon 8s linear infinite;
}
.shell-tool-name {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}
.shell-tool-name strong {
  font-size: 14px;
  font-weight: 800;
  color: var(--text);
}
.shell-tool-name small {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shell-switch {
  position: relative;
  flex: none;
  width: 56px;
  height: 28px;
  border-radius: 99px;
  background: #4b5563;
  color: white;
  animation: enable-switch 8s linear infinite;
}
.shell-switch i {
  position: absolute;
  left: 2px;
  top: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px #0005;
  animation: enable-knob 8s linear infinite;
}
.switch-off,.switch-on {
  position: absolute;
  top: 9px;
  font-size: 9px;
  font-weight: 900;
  line-height: 1;
}
.switch-off {
  right: 5px;
  animation: hide-off 8s linear infinite;
}
.switch-on {
  left: 5px;
  opacity: 0;
  animation: show-on 8s linear infinite;
}
.switch-pointer {
  position: absolute;
  z-index: 2;
  top: 16px;
  right: -8px;
  color: var(--text);
  fill: var(--bg);
  filter: drop-shadow(0 2px 2px #000);
  animation: switch-pointer 8s ease-in-out infinite;
}
.shell-settings-panel {
  width: 100%;
  max-width: 390px;
  height: 118px;
  margin: 13px auto 0;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--surface);
  opacity: 0;
  animation: show-settings 8s ease-out infinite;
}
.shell-settings-heading {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 15px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-3);
  color: var(--text);
  font-size: 12px;
}
.mount-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 18px 15px;
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
}
.mount-row span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.mount-row code {
  font: 10px/1.4 ui-monospace,monospace;
}
.mount-switch {
  position: relative;
  flex: none;
  width: 29px;
  height: 15px;
  border-radius: 99px;
  background: #4b5563;
}
.mount-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: white;
}

@keyframes tools-trigger {
  0%,11%,29%,100% {
    background: transparent;
    color: var(--muted);
  }
  15%,24% {
    background: color-mix(in srgb,var(--blue) 16%,var(--surface-2));
    color: var(--blue);
  }
}
@keyframes open-pointer {
  0%,7%,29%,100% {
    opacity: 0;
    transform: translate(9px,8px);
  }
  13%,24% {
    opacity: 1;
    transform: none;
  }
}
@keyframes sheet-shade {
  0%,27%,100% {
    opacity: 0;
  }
  38%,91% {
    opacity: 1;
  }
}
@keyframes open-sheet {
  0%,27%,100% {
    transform: translateY(102%);
  }
  40%,91% {
    transform: none;
  }
}
@keyframes enable-card {
  0%,30%,100% {
    border-color: var(--line-strong);
    background: var(--surface-2);
  }
  40%,91% {
    border-color: var(--line-strong);
    background: var(--surface-3);
  }
}
@keyframes enable-icon {
  0%,30%,100% {
    background: var(--bg);
    color: var(--muted);
  }
  40%,91% {
    background: var(--surface-2);
    color: var(--blue);
  }
}
@keyframes enable-switch {
  0%,30%,100% {
    background: #4b5563;
  }
  40%,91% {
    background: #2563eb;
  }
}
@keyframes enable-knob {
  0%,30%,100% {
    transform: none;
  }
  40%,91% {
    transform: translateX(28px);
  }
}
@keyframes hide-off {
  0%,30%,100% {
    opacity: 1;
  }
  40%,91% {
    opacity: 0;
  }
}
@keyframes show-on {
  0%,30%,100% {
    opacity: 0;
  }
  40%,91% {
    opacity: 1;
  }
}
@keyframes switch-pointer {
  0%,10%,43%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  19%,29% {
    opacity: 1;
    transform: none;
  }
}
@keyframes show-settings {
  0%,36%,100% {
    opacity: 0;
    transform: translateY(5px);
  }
  46%,91% {
    opacity: 1;
    transform: none;
  }
}

html:has(#docs-pause-motion:checked) .shell-enable-camera *,
html:has(#docs-pause-motion:checked) .shell-enable-camera *::before,
html:has(#docs-pause-motion:checked) .shell-enable-camera *::after,
html:has(#docs-pause-motion:checked) .shell-enable-camera :deep([data-testid="docs-chat-input-tools"]) {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .stage-open .sheet-backdrop {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-open .tools-sheet {
  transform: none;
}
html:has(#docs-pause-motion:checked) .stage-open .open-pointer,
html:has(#docs-pause-motion:checked) .stage-enable .switch-pointer {
  display: none;
}
html:has(#docs-pause-motion:checked) .stage-enable .shell-tool-card {
  border-color: var(--line-strong);
  background: var(--surface-3);
}
html:has(#docs-pause-motion:checked) .stage-enable .shell-tool-icon {
  background: var(--surface-2);
  color: var(--blue);
}
html:has(#docs-pause-motion:checked) .stage-enable .shell-switch {
  background: #2563eb;
  color: white;
}
html:has(#docs-pause-motion:checked) .stage-enable .shell-switch i {
  transform: translateX(28px);
}
html:has(#docs-pause-motion:checked) .stage-enable .switch-off {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .stage-enable .switch-on,
html:has(#docs-pause-motion:checked) .stage-enable .tool-inherit,
html:has(#docs-pause-motion:checked) .stage-enable .shell-settings-panel {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion:reduce) {
  .shell-enable-camera *,.shell-enable-camera *::before,.shell-enable-camera *::after,
  .shell-enable-camera :deep([data-testid="docs-chat-input-tools"]) {
    animation: none!important;
  }
  .stage-open .sheet-backdrop {
    opacity: 1;
  }
  .stage-open .tools-sheet {
    transform: none;
  }
  .stage-open .open-pointer,.stage-enable .switch-pointer {
    display: none;
  }
  .stage-enable .shell-tool-card {
    border-color: var(--line-strong);
    background: var(--surface-3);
  }
  .stage-enable .shell-tool-icon {
    background: var(--surface-2);
    color: var(--blue);
  }
  .stage-enable .shell-switch {
    background: #2563eb;
    color: white;
  }
  .stage-enable .shell-switch i {
    transform: translateX(28px);
  }
  .stage-enable .switch-off {
    opacity: 0;
  }
  .stage-enable .switch-on,.stage-enable .tool-inherit,.stage-enable .shell-settings-panel {
    opacity: 1;
    transform: none;
  }
}
@media (max-width:420px) {
  .shell-enable-camera {
    height: 268px;
  }
  .chat-composer {
    left: 10px;
    right: 10px;
  }
  .tools-sheet {
    height: 204px;
  }
  .tools-grid {
    gap: 6px;
    padding-inline: 9px;
  }
  .tool-preview {
    gap: 4px;
    padding-inline: 5px;
  }
  .preview-switch {
    width: 35px;
  }
  .tool-scene {
    padding-inline: 12px;
  }
  .shell-tool-card {
    margin-top: 20px;
  }
}
</style>
