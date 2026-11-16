<script setup lang="ts">
import { ArrowRightIcon, ArrowUpIcon, AudioLinesIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderOpenIcon, ImageIcon, LibraryBigIcon, MessageSquarePlusIcon, MicIcon, MousePointer2Icon, PlusIcon, SlidersHorizontalIcon, SquareIcon, UserIcon, XIcon } from 'lucide-vue-next';
import type { LiveConversationGuideMessages } from '../../messages/types';

const { stage, messages } = defineProps<{ stage: 'prepare' | 'talk' | 'interrupt' | 'attachments' | 'shell'; messages: LiveConversationGuideMessages }>();
const replyCharacters = [...messages.sample_answer].map((character, index, characters) => ({ character, delay: `${(index * 2.6 / Math.max(characters.length - 1, 1)).toFixed(3)}s` }));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="live-camera" :class="`stage-${stage}`" :data-testid="`live-step-${stage}`" :data-docs-animation="`live-${stage}`" aria-hidden="true">
    <div class="live-canvas">
      <div class="live-app">
        <header class="live-header">
          <div class="header-row"><AudioLinesIcon :size="21" /><div class="header-model"><small>{{ messages.live_conversation }}</small><strong>{{ messages.audio_model_display }}</strong></div><span class="icon-control" :title="messages.new_conversation"><MessageSquarePlusIcon :size="19" /></span><span class="icon-control settings-icon" :title="messages.conversation_settings"><SlidersHorizontalIcon :size="20" /></span></div>
          <p>{{ messages.ephemeral_notice }}</p>
        </header>

        <div v-if="stage === 'prepare'" class="setup-panel focus-content">
          <h3>{{ messages.conversation_settings }}</h3>
          <div class="field-label">{{ messages.model }}</div>
          <div class="model-select"><span>{{ messages.audio_model_id }}</span><ChevronDownIcon :size="17" /></div>
          <div class="catalog"><div class="disclosure"><LibraryBigIcon :size="18" /><strong>{{ messages.model_catalog }}</strong><ChevronDownIcon :size="16" /></div><div class="catalog-model"><strong>{{ messages.audio_model_name }}</strong><small>{{ messages.required_companion }}</small><span class="use-model-action">{{ messages.use_this_model }}<ArrowRightIcon :size="15" /></span></div></div>
          <div class="runtime-disclosure"><FolderOpenIcon :size="17" /><span>{{ messages.models_and_runtime }}</span><ChevronRightIcon :size="16" /></div>
          <span class="primary start-action">{{ messages.start_session }}<MousePointer2Icon class="pointer start-pointer" :size="24" /></span>
        </div>

        <template v-else>
          <div v-if="stage === 'talk' || stage === 'interrupt'" class="conversation focus-content">
            <div class="turn" data-testid="live-example-turn">
              <div class="user-message"><strong><UserIcon :size="14" />{{ messages.you }}</strong><small><AudioLinesIcon :size="15" />{{ messages.voice_message }}</small><p>{{ stage === 'interrupt' ? messages.sample_interrupted_question : messages.sample_question }}</p></div>
              <div class="assistant-message"><strong><AudioLinesIcon :size="16" />{{ messages.audio_model_display }}</strong><p v-if="stage === 'talk'" class="answer"><span v-for="(item, index) in replyCharacters" :key="index" class="reply-character" :style="{ '--character-delay': item.delay }">{{ item.character }}</span></p><p v-else>{{ messages.sample_interrupted_answer }}</p><p v-if="stage === 'interrupt'" class="discarded">{{ messages.discarded }}</p></div>
            </div>
          </div>

          <div v-if="stage === 'shell'" class="shell-scenes focus-content">
            <div class="shell-config"><h3><ChevronDownIcon :size="16" />{{ messages.session_setup }}</h3><h4>{{ messages.browser_shell }}</h4><div class="checkbox-line"><i class="checkbox checked"><CheckIcon :size="12" /></i>{{ messages.allow_shell_tools }}</div><div class="field-label">{{ messages.folder }}</div><div class="model-select"><span>{{ messages.sample_folder }}</span><ChevronDownIcon :size="16" /></div><div class="checkbox-line"><i class="checkbox" />{{ messages.allow_file_changes }}</div></div>
            <div class="approval" data-testid="live-command-approval"><h3>{{ messages.approval_required }}</h3><pre>cat /workspace/ingredients.txt</pre><div class="approval-actions"><span class="primary approve-action">{{ messages.approve_commands }}<MousePointer2Icon class="pointer approve-pointer" :size="24" /></span><span class="decline-action">{{ messages.deny_commands }}</span></div></div>
          </div>

          <footer v-else class="composer-area focus-content">
            <div class="status-row"><div class="statuses"><span class="status-ready">{{ messages.ready }}</span><span class="status-listening">{{ messages.listening }}</span><span class="status-generating">{{ messages.generating_response }}</span><span class="status-playing">{{ messages.playing_response }}</span></div><span v-if="stage === 'interrupt'" class="interrupt-action"><SquareIcon :size="13" />{{ messages.interrupt }}<MousePointer2Icon class="pointer interrupt-pointer" :size="24" /></span></div>
            <div class="composer">
              <div v-if="stage === 'attachments'" class="audio-attachment"><AudioLinesIcon :size="17" /><span>{{ messages.sample_audio_file }}</span><XIcon :size="14" /></div>
              <div class="message-input"><span class="placeholder">{{ messages.message_placeholder }}</span><span v-if="stage === 'interrupt'" class="replacement-message">{{ messages.sample_replacement_question }}</span></div>
              <div class="composer-controls">
                <span class="attach-control icon-control" :title="messages.add_attachment"><PlusIcon :size="21" /><MousePointer2Icon v-if="stage === 'attachments'" class="pointer attach-pointer" :size="24" /></span>
                <div v-if="stage === 'attachments'" class="attachment-menu"><div class="image-option"><ImageIcon :size="16" /><span>{{ messages.images }}</span></div><div class="audio-option"><AudioLinesIcon :size="16" /><span>{{ messages.audio_file }}</span><MousePointer2Icon class="pointer audio-pointer" :size="24" /></div></div>
                <span class="record-control"><MicIcon class="mic-icon" :size="20" /><SquareIcon class="finish-icon" :size="17" /><MousePointer2Icon v-if="stage === 'talk'" class="pointer record-pointer" :size="24" /><span v-if="stage === 'talk'" class="control-label talk-label">{{ messages.talk }}</span><span v-if="stage === 'talk'" class="control-label finish-label">{{ messages.finish_speaking_and_send }}</span></span>
                <span class="send-control" :title="messages.send" data-testid="live-send-control"><ArrowUpIcon :size="20" /></span>
              </div>
            </div>
          </footer>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-camera {
  --app-bg: #111827;
  --app-surface: #1f2937;
  --app-muted-surface: #1f293799;
  --app-line: #374151;
  --app-text: #f3f4f6;
  --app-muted: #9ca3af;
  --app-blue: #60a5fa;
  --focus-width: 420px;
  --camera-y: -78px;
  position: relative;
  height: 454px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--app-bg);
  color: var(--app-text);
  font: 13px/1.6 ui-sans-serif, system-ui, sans-serif;
  text-align: left;
}
html[data-theme='light'] .live-camera,
html:has(#docs-light-theme:checked) .live-camera {
  --app-bg: #fcfcfd;
  --app-surface: #fff;
  --app-muted-surface: #f3f4f6;
  --app-line: #e5e7eb;
  --app-text: #111827;
  --app-muted: #6b7280;
  --app-blue: #2563eb;
}
.live-canvas {
  position: absolute;
  left: 50%;
  width: 680px;
  transform: translate(-50%,var(--camera-y));
  transform-origin: top center;
}
.live-app {
  min-height: 690px;
  background: var(--app-bg);
}
.stage-interrupt .live-app,.stage-attachments .live-app {
  animation: scene-replay 10s linear infinite;
}
.focus-content {
  width: var(--focus-width);
  margin-inline: auto;
}
.live-header {
  padding: 13px 24px 10px;
  border-bottom: 1px solid var(--app-line);
  background: var(--app-bg);
}
.header-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-row > svg {
  color: var(--app-blue);
}
.header-model {
  display: grid;
  flex: 1;
  min-width: 0;
}
.header-model small {
  color: var(--app-muted);
  font-size: 11px;
}
.header-model strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-header p {
  max-width: 600px;
  margin: 8px auto 0;
  color: var(--app-muted);
  font-size: 10px;
}
.icon-control {
  position: relative;
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  color: var(--app-muted);
}
h3,h4,p {
  margin: 0;
}
.setup-panel {
  padding-top: 24px;
}
.setup-panel h3 {
  margin-bottom: 20px;
  font-size: 17px;
}
.field-label {
  margin-bottom: 7px;
  font-weight: 600;
}
.model-select {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--app-line);
  border-radius: 10px;
  background: var(--app-surface);
}
.model-select span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.model-select svg {
  flex: none;
  color: var(--app-muted);
}
.catalog {
  margin-top: 18px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: var(--app-muted-surface);
}
.disclosure,.runtime-disclosure {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
}
.disclosure svg:first-child {
  color: var(--app-blue);
}
.disclosure svg:last-child,.runtime-disclosure svg:last-child {
  flex: none;
  margin-left: auto;
}
.catalog-model {
  display: grid;
  gap: 3px;
  padding: 0 14px 14px;
}
.catalog-model small {
  color: var(--app-muted);
  font-size: 11px;
}
.use-model-action {
  display: flex;
  align-items: center;
  gap: 7px;
  justify-self: end;
  margin-top: 8px;
  padding: 5px 9px;
  border: 1px solid var(--app-line);
  border-radius: 7px;
  color: var(--app-blue);
  font-size: 11px;
}
.runtime-disclosure {
  margin-block: 18px;
  border: 1px solid var(--app-line);
  border-radius: 10px;
  font-size: 12px;
}
.primary {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 8px 14px;
  border-radius: 11px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
}
.pointer {
  position: absolute;
  z-index: 5;
  right: -11px;
  bottom: -12px;
  color: var(--app-text);
  fill: var(--app-surface);
  filter: drop-shadow(0 2px 2px #0005);
  opacity: 0;
}
.stage-prepare .start-pointer {
  animation: start-pointer 10s linear infinite;
}
.stage-prepare .start-action {
  animation: start-highlight 10s linear infinite;
}
.stage-prepare .live-canvas {
  animation: prepare-camera 10s ease-in-out infinite;
}
.stage-talk,.stage-interrupt {
  --camera-y: -115px;
}
.conversation {
  position: relative;
  padding-top: 25px;
}
.user-message {
  width: 88%;
  margin-left: auto;
  padding: 13px 15px;
  border-radius: 16px 3px 16px 16px;
  background: var(--app-muted-surface);
}
.user-message strong,.user-message small,.assistant-message strong {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
}
.user-message strong,.user-message small {
  color: var(--app-muted);
}
.user-message small {
  margin-top: 7px;
}
.user-message p {
  margin-top: 8px;
}
.assistant-message {
  padding: 22px 8px 0 0;
}
.assistant-message strong {
  color: var(--app-blue);
}
.assistant-message > p {
  margin-top: 11px;
  line-height: 1.8;
}
.reply-character {
  opacity: 0;
  animation: response-character 12s linear var(--character-delay) infinite;
}
.stage-talk .user-message {
  animation: sent-message 12s linear infinite;
}
.stage-talk .assistant-message {
  animation: received-message 12s linear infinite;
}
.stage-talk .conversation {
  animation: scene-replay 12s linear infinite;
}
.composer-area {
  position: absolute;
  top: 410px;
  left: 50%;
  transform: translateX(-50%);
}
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 37px;
  margin-bottom: 6px;
  color: var(--app-muted);
  font-size: 11px;
}
.statuses {
  display: grid;
  flex: 1;
  min-width: 0;
}
.statuses > span {
  grid-area: 1/1;
}
.status-listening,.status-generating,.status-playing {
  opacity: 0;
}
.composer {
  position: relative;
  padding: 14px 12px 11px;
  border: 1px solid var(--app-line);
  border-radius: 16px;
  background: var(--app-surface);
  box-shadow: 0 1px 3px #0001;
}
.message-input {
  display: grid;
  min-height: 54px;
  padding: 0 3px 10px;
  color: var(--app-muted);
}
.message-input > span {
  grid-area: 1/1;
}
.composer-controls {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}
.record-control,.send-control {
  position: relative;
  display: grid;
  width: 42px;
  height: 42px;
  flex: none;
  place-items: center;
  border-radius: 50%;
}
.record-control {
  margin-left: auto;
  border: 1px solid var(--app-line);
  color: var(--app-text);
}
.record-control > .mic-icon,.record-control > .finish-icon {
  grid-area: 1/1;
}
.finish-icon {
  opacity: 0;
  fill: currentColor;
}
.send-control {
  background: #2563eb;
  color: #fff;
  opacity: .4;
}
.control-label {
  position: absolute;
  right: -1px;
  bottom: 54px;
  width: max-content;
  max-width: 230px;
  padding: 6px 10px;
  border: 1px solid var(--app-line);
  border-radius: 7px;
  background: var(--app-text);
  color: var(--app-surface);
  font-size: 11px;
  line-height: 1.5;
}
.finish-label {
  opacity: 0;
}
.stage-talk .record-control {
  animation: record-state 12s linear infinite;
}
.stage-talk .mic-icon {
  animation: talk-control 12s linear infinite;
}
.stage-talk .talk-label {
  animation: talk-label 12s linear infinite;
}
.stage-talk .finish-icon,.stage-talk .finish-label {
  animation: finish-control 12s linear infinite;
}
.stage-talk .record-pointer {
  animation: record-pointer 12s linear infinite;
}
.stage-talk .status-ready {
  animation: ready-status 12s linear infinite;
}
.stage-talk .status-listening {
  animation: listening-status 12s linear infinite;
  color: #ef4444;
}
.stage-talk .status-generating {
  animation: generating-status 12s linear infinite;
}
.stage-talk .status-playing {
  animation: playing-status 12s linear infinite;
}
.interrupt-action {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--app-line);
  border-radius: 8px;
  color: var(--app-text);
  animation: interrupt-action 10s linear infinite;
}
.stage-interrupt .status-generating {
  animation: interrupt-status 10s linear infinite;
}
.stage-interrupt .status-ready {
  animation: interrupted-ready 10s linear infinite;
}
.stage-interrupt .turn {
  animation: discarded-turn 10s linear infinite;
}
.discarded {
  color: #fcd34d;
  font-size: 11px;
  opacity: 0;
  animation: discarded-marker 10s linear infinite;
}
html[data-theme='light'] .discarded,
html:has(#docs-light-theme:checked) .discarded {
  color: #b45309;
}
.interrupt-pointer {
  animation: interrupt-pointer 10s linear infinite;
}
.replacement-message {
  color: var(--app-text);
  opacity: 0;
  animation: replacement-message 10s linear infinite;
}
.stage-interrupt .placeholder {
  animation: replacement-placeholder 10s linear infinite;
}
.stage-interrupt .send-control {
  animation: replacement-send 10s linear infinite;
}
.stage-attachments {
  --camera-y: -180px;
}
.stage-attachments .composer-area {
  top: 350px;
}
.attachment-menu {
  position: absolute;
  z-index: 3;
  bottom: 51px;
  left: 0;
  width: 246px;
  padding: 6px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: var(--app-surface);
  box-shadow: 0 10px 25px #0003;
  opacity: 0;
  animation: attachment-menu 10s linear infinite;
}
.attachment-menu > div {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 46px;
  padding: 8px 10px;
}
.image-option {
  opacity: .4;
}
.audio-option {
  border-radius: 7px;
  background: var(--app-muted-surface);
}
.audio-attachment {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: var(--app-muted-surface);
  opacity: 0;
  animation: audio-attachment 10s linear infinite;
}
.audio-attachment > svg:first-child {
  color: var(--app-blue);
}
.audio-attachment > svg:last-child {
  margin-left: auto;
}
.stage-attachments .record-control {
  animation: audio-record 10s linear infinite;
}
.stage-attachments .send-control {
  animation: audio-send 10s linear infinite;
}
.attach-pointer {
  animation: attachment-pointer 10s linear infinite;
}
.audio-pointer {
  animation: audio-pointer 10s linear infinite;
}
.stage-shell {
  --camera-y: -90px;
}
.stage-shell .live-canvas {
  animation: shell-camera 12s ease-in-out infinite;
}
.shell-config {
  padding-top: 26px;
}
.shell-config h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.shell-config h4 {
  margin-top: 18px;
  font-size: 13px;
}
.checkbox-line {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-block: 12px;
  font-size: 12px;
}
.checkbox {
  display: grid;
  width: 15px;
  height: 15px;
  flex: none;
  place-items: center;
  border: 1px solid var(--app-line);
  border-radius: 4px;
}
.checked {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}
.approval {
  margin-top: 48px;
  padding: 16px;
  border: 1px solid #d97706;
  border-radius: 12px;
}
.approval h3 {
  font-size: 13px;
  line-height: 1.6;
}
.approval pre {
  margin: 14px 0;
  padding: 12px;
  border-radius: 8px;
  background: var(--app-muted-surface);
  color: var(--app-text);
  font: 12px/1.7 ui-monospace, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.approval-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  font-size: 11px;
}
.approve-action {
  border-radius: 8px;
  font-weight: 500;
}
.decline-action {
  padding: 8px 10px;
  border: 1px solid var(--app-line);
  border-radius: 8px;
}
.approve-pointer {
  animation: approve-pointer 12s linear infinite;
}
@keyframes start-pointer {
  0%,16%,60%,100% {
    opacity: 0;
    transform: translate(9px,9px);
  }
  25%,50% {
    opacity: 1;
    transform: none;
  }
}
@keyframes prepare-camera {
  0%,20%,100% {
    transform: translate(-50%,-78px);
  }
  45%,92% {
    transform: translate(-50%,-138px);
  }
}
@keyframes start-highlight {
  0%,30%,54%,100% {
    box-shadow: none;
  }
  36%,47% {
    box-shadow: 0 0 0 5px #2563eb25;
  }
}
@keyframes scene-replay {
  0%,3%,100% {
    opacity: 0;
  }
  5%,94% {
    opacity: 1;
  }
}
@keyframes sent-message {
  0%,34% {
    opacity: 0;
  }
  39%,100% {
    opacity: 1;
  }
}
@keyframes received-message {
  0%,43% {
    opacity: 0;
  }
  48%,100% {
    opacity: 1;
  }
}
@keyframes response-character {
  0%,46% {
    opacity: 0;
  }
  46.1%,100% {
    opacity: 1;
  }
}
@keyframes record-state {
  0%,12%,34%,100% {
    background: var(--app-surface);
    color: var(--app-text);
    border-color: var(--app-line);
  }
  14%,32% {
    background: #ef4444;
    color: #fff;
    border-color: #ef4444;
  }
}
@keyframes talk-control {
  0%,12%,35%,100% {
    opacity: 1;
  }
  14%,33% {
    opacity: 0;
  }
}
@keyframes talk-label {
  0%,12% {
    opacity: 1;
  }
  14%,100% {
    opacity: 0;
  }
}
@keyframes finish-control {
  0%,12%,35%,100% {
    opacity: 0;
  }
  14%,33% {
    opacity: 1;
  }
}
@keyframes record-pointer {
  0%,5%,19%,25%,38%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  9%,15%,29%,34% {
    opacity: 1;
    transform: none;
  }
}
@keyframes ready-status {
  0%,12%,86%,100% {
    opacity: 1;
  }
  14%,84% {
    opacity: 0;
  }
}
@keyframes listening-status {
  0%,12%,35%,100% {
    opacity: 0;
  }
  14%,33% {
    opacity: 1;
  }
}
@keyframes generating-status {
  0%,34%,63%,100% {
    opacity: 0;
  }
  36%,61% {
    opacity: 1;
  }
}
@keyframes playing-status {
  0%,62%,86%,100% {
    opacity: 0;
  }
  64%,84% {
    opacity: 1;
  }
}
@keyframes interrupt-action {
  0%,43%,100% {
    opacity: 1;
  }
  47%,96% {
    opacity: 0;
  }
}
@keyframes interrupt-status {
  0%,43%,100% {
    opacity: 1;
  }
  47%,96% {
    opacity: 0;
  }
}
@keyframes interrupted-ready {
  0%,43%,100% {
    opacity: 0;
  }
  47%,96% {
    opacity: 1;
  }
}
@keyframes discarded-turn {
  0%,43%,100% {
    opacity: 1;
  }
  47%,96% {
    opacity: .6;
  }
}
@keyframes discarded-marker {
  0%,43%,100% {
    opacity: 0;
  }
  47%,96% {
    opacity: 1;
  }
}
@keyframes interrupt-pointer {
  0%,20%,49%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  28%,43% {
    opacity: 1;
    transform: none;
  }
}
@keyframes replacement-message {
  0%,58%,100% {
    opacity: 0;
  }
  65%,94% {
    opacity: 1;
  }
}
@keyframes replacement-placeholder {
  0%,58%,100% {
    opacity: 1;
  }
  65%,94% {
    opacity: 0;
  }
}
@keyframes replacement-send {
  0%,58%,100% {
    opacity: .4;
  }
  65%,94% {
    opacity: 1;
  }
}
@keyframes attachment-menu {
  0%,18%,57%,100% {
    opacity: 0;
    transform: translateY(5px);
  }
  24%,52% {
    opacity: 1;
    transform: none;
  }
}
@keyframes audio-attachment {
  0%,52%,100% {
    opacity: 0;
  }
  59%,94% {
    opacity: 1;
  }
}
@keyframes audio-send {
  0%,52%,100% {
    opacity: .4;
  }
  59%,94% {
    opacity: 1;
  }
}
@keyframes audio-record {
  0%,52%,100% {
    opacity: 1;
  }
  59%,94% {
    opacity: .4;
  }
}
@keyframes attachment-pointer {
  0%,6%,28%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  12%,22% {
    opacity: 1;
    transform: none;
  }
}
@keyframes audio-pointer {
  0%,34%,58%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  40%,52% {
    opacity: 1;
    transform: none;
  }
}
@keyframes shell-camera {
  0%,22%,100% {
    transform: translate(-50%,-90px);
  }
  48%,92% {
    transform: translate(-50%,-290px);
  }
}
@keyframes approve-pointer {
  0%,58%,83%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  65%,77% {
    opacity: 1;
    transform: none;
  }
}
html:has(#docs-pause-motion:checked) .live-camera *,
html:has(#docs-pause-motion:checked) .live-camera *::before,
html:has(#docs-pause-motion:checked) .live-camera *::after {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .live-camera .pointer,
html:has(#docs-pause-motion:checked) .live-camera .attachment-menu,
html:has(#docs-pause-motion:checked) .live-camera .finish-icon,
html:has(#docs-pause-motion:checked) .live-camera .control-label,
html:has(#docs-pause-motion:checked) .stage-interrupt .interrupt-action,
html:has(#docs-pause-motion:checked) .stage-interrupt .status-generating,
html:has(#docs-pause-motion:checked) .stage-interrupt .placeholder {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .live-camera .reply-character,
html:has(#docs-pause-motion:checked) .live-camera .audio-attachment,
html:has(#docs-pause-motion:checked) .live-camera .discarded,
html:has(#docs-pause-motion:checked) .live-camera .replacement-message,
html:has(#docs-pause-motion:checked) .stage-interrupt .send-control,
html:has(#docs-pause-motion:checked) .stage-attachments .send-control {
  animation: none!important;
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-interrupt .turn {
  opacity: .6;
}
html:has(#docs-pause-motion:checked) .stage-attachments .record-control {
  opacity: .4;
}
html:has(#docs-pause-motion:checked) .stage-shell .live-canvas {
  transform: translate(-50%,-290px);
}
html:has(#docs-pause-motion:checked) .stage-prepare .live-canvas {
  transform: translate(-50%,-138px);
}
@media(prefers-reduced-motion:reduce) {
  .live-camera *, .live-camera *::before, .live-camera *::after {
    animation: none!important;
  }
  .pointer,.attachment-menu,.finish-icon,.control-label,.stage-interrupt .interrupt-action,.stage-interrupt .status-generating,.stage-interrupt .placeholder {
    opacity: 0;
  }
  .reply-character,.audio-attachment,.discarded,.replacement-message,.stage-interrupt .send-control,.stage-attachments .send-control {
    animation: none!important;
    opacity: 1;
  }
  .stage-interrupt .turn {
    opacity: .6;
  }
  .stage-attachments .record-control {
    opacity: .4;
  }
  .stage-shell .live-canvas {
    transform: translate(-50%,-290px);
  }
  .stage-prepare .live-canvas {
    transform: translate(-50%,-138px);
  }
}
@media(max-width:560px) {
  .live-camera {
    --focus-width: 276px;
    height: 466px;
  }
  .stage-talk,.stage-interrupt {
    --camera-y: -118px;
  }
  .stage-talk .composer-area,.stage-interrupt .composer-area {
    top: 405px;
  }
  .user-message {
    width: 94%;
  }
  .assistant-message > p {
    line-height: 1.7;
  }
  .control-label {
    max-width: 208px;
  }
  .approval {
    margin-top: 32px;
    padding: 13px;
  }
  .approval-actions {
    gap: 9px;
  }
  .approve-action {
    padding: 8px 10px;
  }
}
</style>
