<script setup lang="ts">
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, BirdIcon, ChevronDownIcon, CpuIcon, FilesIcon, FolderIcon, FolderSymlinkIcon, ImageIcon, MessageSquareIcon, MousePointer2Icon, SquareIcon, UserIcon } from 'lucide-vue-next';
import NaidanAppFrame from './NaidanAppFrame.vue';
import NaidanChatInput from './NaidanChatInput.vue';
import NoticeImage from '../../pages/image-understanding/NoticeImage.vue';
import kitten from '../../assets/flying-kitten.webp';
import type { ImageUnderstandingGuideMessages } from '../../messages/types';

const { messages } = defineProps<{ stage: 'flow' | 'model' | 'attach' | 'ask' | 'transcribe' | 'table'; messages: ImageUnderstandingGuideMessages; chrome: Readonly<typeof import('../../messages/replica-chrome/en').messages> }>();

function characters({ text, seconds }: { text: string; seconds: number }) {
  return [...text].map((character, index, all) => ({ character, delay: `${(index * seconds / Math.max(all.length - 1, 1)).toFixed(3)}s` }));
}

const photoCharacters = characters({ text: messages.photo_answer, seconds: 2.5 });
const followupCharacters = characters({ text: messages.followup_answer, seconds: 2 });
const noticeCharacters = characters({ text: messages.notice_answer, seconds: 3.5 });
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="stage === 'flow'" class="local-flow" data-docs-animation="image-understanding-flow" data-testid="image-understanding-flow" aria-hidden="true">
    <div class="flow-input"><ImageIcon :size="25" /><b>{{ messages.flow_input }}</b><img :src="kitten" alt="" width="56" height="56"></div>
    <ArrowRightIcon class="flow-arrow" :size="24" />
    <div class="flow-browser"><span>{{ messages.flow_browser }}</span><div class="flow-model"><CpuIcon :size="26" /><b>{{ messages.flow_model }}</b><small>{{ messages.flow_companion }}</small></div></div>
    <ArrowRightIcon class="flow-arrow flow-arrow-answer" :size="24" />
    <div class="flow-answer"><MessageSquareIcon :size="25" /><b>{{ messages.flow_answer }}</b></div>
  </div>

  <div v-else class="image-camera" :class="`stage-${stage}`" :data-docs-animation="`image-understanding-${stage}`" :data-testid="`image-understanding-${stage}`" aria-hidden="true">
    <div class="image-canvas">
      <NaidanAppFrame :messages="chrome" :title="stage === 'model' ? chrome.chrome_new_chat : messages.chat_title" address="Naidan" sidebar="hidden" :model="stage === 'model' ? undefined : messages.sample_model">
        <div v-if="stage === 'model'" class="model-scene">
          <div class="model-opener"><CpuIcon :size="15" />{{ messages.use_local_model_files }}<ChevronDownIcon :size="14" /></div>
          <div class="source-tabs"><span>{{ messages.files }}</span><strong>Hugging Face</strong><span>{{ messages.saved_models }}</span></div>
          <div class="model-configuration" data-testid="image-understanding-model-configuration">
            <span class="back-to-search"><ArrowLeftIcon :size="13" />{{ messages.back_to_search }}</span>
            <strong class="repository">{{ messages.sample_repository }}</strong>
            <div class="configuration-row"><span>{{ messages.quantization }}</span><span class="select-value">Q4_K_M<ChevronDownIcon :size="13" /></span></div>
            <div class="configuration-row"><span>{{ messages.multimodal_support }}</span><span class="multimodal-switch"><i /><MousePointer2Icon class="pointer switch-pointer" :size="20" /></span></div>
            <div class="configuration-row companion-row" data-testid="image-understanding-companion"><span>{{ messages.multimodal_quantization }}</span><span class="select-value">F16<ChevronDownIcon :size="13" /></span></div>
            <div class="destination-row"><span>{{ messages.download_to }}</span><span class="select-value">{{ messages.browser_storage }}<ChevronDownIcon :size="13" /></span></div>
            <strong class="use-model">{{ messages.use_model_in_this_chat }}<ArrowRightIcon :size="15" /><MousePointer2Icon class="pointer model-pointer" :size="20" /></strong>
          </div>
        </div>

        <div v-else-if="stage === 'attach'" class="attach-scene">
          <div class="attach-preview" data-testid="image-understanding-attachment-preview"><img :src="kitten" alt="" width="80" height="80"></div>
          <NaidanChatInput class="image-composer" :messages="chrome" :model="messages.sample_model" status="idle">
            <template #attach><MousePointer2Icon class="pointer attach-pointer" :size="20" /><div class="attach-menu" data-testid="image-understanding-attach-menu"><strong><FilesIcon :size="17" />{{ messages.files }}<MousePointer2Icon class="pointer files-pointer" :size="20" /></strong><span><FolderSymlinkIcon :size="17" />{{ messages.folder_link }}</span><span><FolderIcon :size="17" />{{ messages.folder_copy }}</span></div></template>
          </NaidanChatInput>
        </div>

        <div v-else class="chat-scene">
          <div class="thread-window">
            <div class="thread-messages">
              <template v-if="stage === 'ask'">
                <div class="message user-message sent-question"><div class="message-heading"><UserIcon :size="16" /><b>{{ messages.you }}</b></div><img class="message-image" :src="kitten" alt="" width="88" height="88"><p>{{ messages.photo_prompt }}</p></div>
                <div class="message assistant-message first-answer" data-testid="image-understanding-photo-answer"><div class="message-heading"><BirdIcon :size="16" /><b>Gemma 4</b></div><p class="stream first-stream"><span v-for="(item, index) in photoCharacters" :key="index" class="stream-character" :style="{ '--reveal-delay': item.delay }">{{ item.character }}</span></p></div>
                <div class="message user-message followup-question"><div class="message-heading"><UserIcon :size="16" /><b>{{ messages.you }}</b></div><p>{{ messages.followup_prompt }}</p></div>
                <div class="message assistant-message followup-answer" data-testid="image-understanding-followup-answer"><div class="message-heading"><BirdIcon :size="16" /><b>Gemma 4</b></div><p class="stream second-stream"><span v-for="(item, index) in followupCharacters" :key="index" class="stream-character" :style="{ '--reveal-delay': item.delay }">{{ item.character }}</span></p></div>
              </template>
              <template v-else-if="stage === 'transcribe'">
                <div class="message user-message sent-question"><div class="message-heading"><UserIcon :size="16" /><b>{{ messages.you }}</b></div><NoticeImage class="message-notice" :messages="messages" /><p>{{ messages.transcribe_prompt }}</p></div>
                <div class="message assistant-message first-answer"><div class="message-heading"><BirdIcon :size="16" /><b>Gemma 4</b></div><p class="stream first-stream notice-answer" data-testid="image-understanding-transcribed-text"><span v-for="(item, index) in noticeCharacters" :key="index" class="stream-character" :style="{ '--reveal-delay': item.delay }">{{ item.character }}</span></p></div>
              </template>
              <template v-else>
                <div class="message assistant-message previous-text"><div class="message-heading"><BirdIcon :size="16" /><b>Gemma 4</b></div><p class="notice-answer">{{ messages.notice_answer }}</p></div>
                <div class="message user-message sent-question"><div class="message-heading"><UserIcon :size="16" /><b>{{ messages.you }}</b></div><p>{{ messages.table_prompt }}</p></div>
                <div class="message assistant-message table-answer"><div class="message-heading"><BirdIcon :size="16" /><b>Gemma 4</b></div><table data-testid="image-understanding-result-table"><thead><tr><th>{{ messages.table_event }}</th><th>{{ messages.table_time }}</th><th>{{ messages.table_place }}</th></tr></thead><tbody><tr class="result-row first-row"><td>{{ messages.notice_first_event }}</td><td>{{ messages.notice_first_time }}</td><td>{{ messages.notice_first_place }}</td></tr><tr class="result-row second-row"><td>{{ messages.notice_second_event }}</td><td>{{ messages.notice_second_time }}</td><td>{{ messages.notice_second_place }}</td></tr></tbody></table></div>
              </template>
            </div>
          </div>
          <div v-if="stage !== 'table'" class="draft-attachment"><img v-if="stage === 'ask'" :src="kitten" alt="" width="80" height="80"><NoticeImage v-else :messages="messages" /></div>
          <NaidanChatInput class="image-composer" :messages="chrome" :model="messages.sample_model" status="ready"><span class="composer-copy"><span class="draft-prompt">{{ stage === 'ask' ? messages.photo_prompt : stage === 'transcribe' ? messages.transcribe_prompt : messages.table_prompt }}</span><span class="draft-placeholder">{{ chrome.chrome_input_placeholder }}</span></span><template #send><span class="send-ready"><ArrowUpIcon :size="16" /></span><span class="send-generating"><SquareIcon :size="13" /></span><MousePointer2Icon class="pointer send-pointer" :size="20" /></template></NaidanChatInput>
        </div>
      </NaidanAppFrame>
    </div>
  </div>
</template>

<style scoped>
.local-flow {
  display: grid;
  grid-template-columns: 100px 24px minmax(160px,1fr) 24px 82px;
  align-items: center;
  gap: 14px;
  max-width: 660px;
  min-height: 240px;
  margin-inline: auto;
  padding: 20px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  color: var(--text);
  background: var(--surface);
  font: 12px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.flow-input,.flow-answer {
  display: grid;
  justify-items: center;
  gap: 8px;
  text-align: center;
}
.flow-input img {
  border-radius: 8px;
}
.flow-browser {
  align-self: stretch;
  display: grid;
  align-content: center;
  gap: 10px;
  padding: 15px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  text-align: center;
  background: var(--bg);
}
.flow-browser > span {
  color: var(--muted);
  font-size: 11px;
}
.flow-model {
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 15px 8px;
  border: 1px solid var(--blue);
  border-radius: 10px;
  background: color-mix(in srgb,var(--blue) 8%,var(--surface));
}
.flow-model svg,.flow-arrow {
  color: var(--blue);
}
.flow-arrow {
  animation: flow-transfer 7s linear infinite;
}
.flow-arrow-answer {
  animation-delay: 2s;
}
@keyframes flow-transfer {
  0%,10%,55%,100% {
    opacity: .35;
    transform: translateX(0);
  }
  25%,40% {
    opacity: 1;
    transform: translateX(4px);
  }
}
.image-camera {
  --thread-rest-y: 0px;
  position: relative;
  height: 510px;
  max-width: 680px;
  overflow: hidden;
  margin-inline: auto;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  container-type: inline-size;
  font: 12px/1.6 ui-sans-serif,system-ui,sans-serif;
}
.image-canvas {
  position: absolute;
  top: 0;
  left: 50%;
  width: min(660px,100cqw);
  transform: translateX(-50%);
}
.image-canvas :deep(.replica) {
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.stage-model {
  height: 620px;
}
.model-scene {
  width: min(460px,calc(100cqw - 32px));
  margin: 18px auto 0;
}
.model-opener {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}
.source-tabs {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  margin-top: 14px;
  border-bottom: 1px solid var(--line);
  color: var(--subtle);
  text-align: center;
  font-size: 11px;
}
.source-tabs > * {
  padding: 10px 0;
}
.source-tabs strong {
  border-bottom: 2px solid var(--blue);
  color: var(--blue);
}
.model-configuration {
  display: grid;
  gap: 10px;
  padding: 12px 2px;
}
.back-to-search {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11px;
}
.repository {
  overflow-wrap: anywhere;
}
.configuration-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
}
.select-value {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text);
  background: var(--surface-2);
}
.multimodal-switch {
  position: relative;
  display: block;
  width: 36px;
  height: 20px;
  border-radius: 20px;
  background: #3b82f6;
  animation: image-switch 16s linear infinite;
}
.multimodal-switch i {
  display: block;
  width: 14px;
  height: 14px;
  margin: 3px 0 0 3px;
  border-radius: 50%;
  background: white;
  transform: translateX(15px);
  animation: image-switch-thumb 16s linear infinite;
}
.companion-row {
  animation: image-companion 16s linear infinite;
}
.destination-row {
  display: grid;
  gap: 7px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 11px;
}
.use-model {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 42px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface-2);
  color: var(--text);
}
.use-model > svg:first-child {
  color: var(--blue);
}
.pointer {
  position: absolute;
  z-index: 4;
  color: var(--text);
  fill: var(--surface);
  filter: drop-shadow(0 1px 2px #0008);
}
.switch-pointer {
  right: -10px;
  bottom: -11px;
  opacity: 0;
  animation: switch-pointer 16s linear infinite;
}
.model-pointer {
  right: 22px;
  bottom: -8px;
  opacity: 0;
  animation: model-pointer 16s linear infinite;
}
@keyframes image-switch {
  0%,18% {
    background: var(--line-strong);
  }
  20%,100% {
    background: #3b82f6;
  }
}
@keyframes image-switch-thumb {
  0%,18% {
    transform: translateX(0);
  }
  20%,100% {
    transform: translateX(15px);
  }
}
@keyframes image-companion {
  0%,19% {
    opacity: 0;
  }
  22%,100% {
    opacity: 1;
  }
}
@keyframes switch-pointer {
  0%,9%,26%,100% {
    opacity: 0;
  }
  13%,22% {
    opacity: 1;
  }
}
@keyframes model-pointer {
  0%,42%,61%,100% {
    opacity: 0;
    transform: translate(6px,5px);
  }
  47%,57% {
    opacity: 1;
    transform: translate(0,0);
  }
}
.stage-attach {
  height: 370px;
}
.attach-scene {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: 267px;
  padding: 16px;
}
.attach-preview {
  padding: 14px 14px 3px;
  border: 1px solid var(--line-strong);
  border-bottom: 0;
  border-radius: 14px 14px 0 0;
  background: var(--surface-3);
  animation: attachment-preview 16s linear infinite;
}
.attach-preview img {
  display: block;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}
.image-composer {
  --chat-input-font-size: 13px;
  --chat-input-control-size: 32px;
}
.attach-scene .image-composer {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.attach-menu {
  position: absolute;
  bottom: 42px;
  left: -3px;
  width: 220px;
  padding: 3px 0;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-2);
  box-shadow: var(--panel-shadow);
  color: var(--muted);
  animation: attach-menu 16s linear infinite;
  opacity: 0;
  font-size: 13px;
}
.attach-menu > * {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
}
.attach-menu > strong {
  color: var(--text);
}
.attach-menu > span {
  border-top: 1px solid var(--line);
}
.attach-pointer {
  right: -6px;
  bottom: -5px;
  opacity: 0;
  animation: attach-pointer 16s linear infinite;
}
.files-pointer {
  right: 30px;
  bottom: 3px;
  opacity: 0;
  animation: files-pointer 16s linear infinite;
}
@keyframes attach-menu {
  0%,12%,43%,100% {
    opacity: 0;
    visibility: hidden;
  }
  15%,40% {
    opacity: 1;
    visibility: visible;
  }
}
@keyframes attach-pointer {
  0%,5%,20%,100% {
    opacity: 0;
  }
  8%,16% {
    opacity: 1;
  }
}
@keyframes files-pointer {
  0%,24%,43%,100% {
    opacity: 0;
    transform: translateY(8px);
  }
  29%,38% {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes attachment-preview {
  0%,44% {
    opacity: 0;
  }
  48%,100% {
    opacity: 1;
  }
}
.stage-ask {
  height: 620px;
  --thread-rest-y: -70px;
}
.stage-transcribe,.stage-table {
  height: 640px;
}
.stage-transcribe {
  --thread-rest-y: -125px;
}
.stage-table {
  --thread-rest-y: -80px;
}
.chat-scene {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 510px;
  padding: 0 15px 14px;
}
.draft-attachment {
  position: absolute;
  z-index: 1;
  bottom: 130px;
  left: 27px;
  width: 100px;
  padding: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-3);
  animation: draft-input 16s linear infinite;
  opacity: 0;
}
.draft-attachment img {
  display: block;
  border-radius: 7px;
}
.composer-copy {
  display: grid;
}
.composer-copy > * {
  grid-area: 1/1;
}
.draft-prompt {
  color: var(--text);
  opacity: 0;
  animation: draft-input 16s linear infinite;
}
.draft-placeholder {
  animation: sent-input 16s linear infinite;
}
.sent-question {
  animation: sent-input 16s linear infinite;
}
.stage-transcribe .chat-scene,.stage-table .chat-scene {
  height: 530px;
}
.thread-window {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  margin-bottom: 12px;
}
.thread-messages {
  animation: thread-scroll 16s ease-in-out infinite;
}
.stage-transcribe .thread-messages,.stage-table .thread-messages {
  animation-name: result-scroll;
}
.message {
  padding: 15px 9px 5px;
}
.message-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}
.message-heading svg {
  color: var(--muted);
}
.assistant-message .message-heading svg {
  color: var(--blue);
}
.image-camera .message p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}
.message-image {
  display: block;
  margin-bottom: 8px;
  border-radius: 9px;
}
.message-notice {
  max-width: 320px;
  margin-bottom: 9px;
}
.first-answer {
  animation: first-answer 16s linear infinite;
}
.followup-question {
  animation: followup-question 16s linear infinite;
}
.followup-answer {
  animation: followup-answer 16s linear infinite;
}
.stream-character {
  opacity: 1;
  animation: first-character 16s linear var(--reveal-delay) infinite both;
}
.second-stream .stream-character {
  animation-name: second-character;
}
.notice-answer {
  white-space: pre-line;
}
.previous-text {
  padding-bottom: 4px;
}
.stage-table .notice-answer {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}
.table-answer {
  animation: first-answer 16s linear infinite;
}
.image-camera table {
  width: 100%;
  margin: 0;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
  line-height: 1.6;
}
.image-camera th,.image-camera td {
  padding: 9px 7px;
  border: 1px solid var(--line-strong);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.image-camera th {
  background: var(--surface-2);
}
.first-row {
  animation: first-table-row 16s linear infinite;
}
.second-row {
  animation: second-table-row 16s linear infinite;
}
.send-ready,.send-generating {
  display: grid;
  place-items: center;
  grid-area: 1/1;
}
.send-generating {
  color: #fff;
  opacity: 0;
  animation: generating 16s linear infinite;
}
.send-generating svg {
  fill: currentColor;
}
.send-pointer {
  right: -3px;
  bottom: -7px;
  opacity: 0;
  animation: send-pointer 16s linear infinite;
}
.send-ready {
  animation: send-ready 16s linear infinite;
}
.chat-scene :deep(.chat-input-send) {
  display: grid;
  background: var(--surface-2);
  color: var(--subtle);
  animation: send-background 16s linear infinite;
}
.stage-transcribe .send-generating,.stage-table .send-generating {
  animation-name: first-generating;
}
.stage-transcribe .send-ready,.stage-table .send-ready {
  animation-name: first-send-ready;
}
.stage-transcribe .chat-scene :deep(.chat-input-send),.stage-table .chat-scene :deep(.chat-input-send) {
  animation-name: first-send-background;
}
@keyframes first-answer {
  0%,23% {
    opacity: 0;
  }
  24%,100% {
    opacity: 1;
  }
}
@keyframes draft-input {
  0%,16% {
    opacity: 1;
    visibility: visible;
  }
  18%,100% {
    opacity: 0;
    visibility: hidden;
  }
}
@keyframes sent-input {
  0%,17% {
    opacity: 0;
  }
  19%,100% {
    opacity: 1;
  }
}
@keyframes send-pointer {
  0%,9%,21%,100% {
    opacity: 0;
  }
  12%,18% {
    opacity: 1;
  }
}
@keyframes first-character {
  0%,25% {
    opacity: 0;
  }
  25.01%,100% {
    opacity: 1;
  }
}
@keyframes followup-question {
  0%,54% {
    opacity: 0;
  }
  55%,100% {
    opacity: 1;
  }
}
@keyframes followup-answer {
  0%,64% {
    opacity: 0;
  }
  65%,100% {
    opacity: 1;
  }
}
@keyframes second-character {
  0%,66% {
    opacity: 0;
  }
  66.01%,100% {
    opacity: 1;
  }
}
@keyframes first-table-row {
  0%,30% {
    opacity: 0;
  }
  33%,100% {
    opacity: 1;
  }
}
@keyframes second-table-row {
  0%,40% {
    opacity: 0;
  }
  43%,100% {
    opacity: 1;
  }
}
@keyframes thread-scroll {
  0%,52% {
    transform: translateY(0);
  }
  65%,100% {
    transform: translateY(var(--thread-rest-y));
  }
}
@keyframes result-scroll {
  0%,33% {
    transform: translateY(0);
  }
  49%,100% {
    transform: translateY(var(--thread-rest-y));
  }
}
@keyframes generating {
  0%,23%,49%,64%,83%,100% {
    opacity: 0;
  }
  24%,48%,65%,82% {
    opacity: 1;
  }
}
@keyframes send-ready {
  0%,23%,49%,64%,83%,100% {
    opacity: 1;
  }
  24%,48%,65%,82% {
    opacity: 0;
  }
}
@keyframes send-background {
  0%,18% {
    background: #2563eb;
    color: white;
  }
  20%,23%,49%,64%,83%,100% {
    background: var(--surface-2);
    color: var(--subtle);
  }
  24%,48%,65%,82% {
    background: #2563eb;
    color: white;
  }
}
@keyframes first-generating {
  0%,23%,49%,100% {
    opacity: 0;
  }
  24%,48% {
    opacity: 1;
  }
}
@keyframes first-send-ready {
  0%,23%,49%,100% {
    opacity: 1;
  }
  24%,48% {
    opacity: 0;
  }
}
@keyframes first-send-background {
  0%,18%,24%,48% {
    background: #2563eb;
    color: white;
  }
  20%,23%,49%,100% {
    background: var(--surface-2);
    color: var(--subtle);
  }
}
html:has(#docs-pause-motion:checked) .image-camera *,
html:has(#docs-pause-motion:checked) .local-flow * {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .image-camera .pointer,
html:has(#docs-pause-motion:checked) .image-camera .attach-menu,
html:has(#docs-pause-motion:checked) .image-camera .send-generating,
html:has(#docs-pause-motion:checked) .image-camera .draft-attachment,
html:has(#docs-pause-motion:checked) .image-camera .draft-prompt {
  display: none;
}
html:has(#docs-pause-motion:checked) .image-camera .thread-messages {
  transform: translateY(var(--thread-rest-y));
}
html:has(#docs-pause-motion:checked) .image-camera .chat-scene :deep(.chat-input-send) {
  animation: none!important;
  background: var(--surface-2);
  color: var(--subtle);
}
@container (max-width: 440px) {
  .model-scene {
    width: calc(100cqw - 28px);
  }
  .image-composer {
    --chat-input-font-size: 12px;
    --chat-input-control-size: 26px;
  }
  .chat-scene {
    padding-inline: 8px;
  }
  .message {
    padding-inline: 5px;
  }
  .stage-ask .thread-messages {
    --thread-rest-y: -195px;
  }
  .stage-transcribe .thread-messages {
    --thread-rest-y: -180px;
  }
  .stage-table .thread-messages {
    --thread-rest-y: -125px;
  }
  .message-notice {
    max-width: 100%;
  }
  .image-camera table {
    font-size: 11px;
  }
  .image-camera th,.image-camera td {
    padding: 7px 5px;
  }
}
@media(max-width: 600px) {
  .local-flow {
    grid-template-columns: 1fr;
    justify-items: center;
    gap: 12px;
    height: 480px;
    padding: 18px;
  }
  .flow-input {
    grid-template-columns: auto auto auto;
    align-items: center;
  }
  .flow-browser {
    width: min(280px,100%);
  }
  .flow-answer {
    grid-template-columns: auto auto;
  }
  .flow-arrow {
    transform: rotate(90deg);
    animation-name: flow-transfer-down;
  }
  @keyframes flow-transfer-down {
    0%,10%,55%,100% {
      opacity: .35;
      transform: rotate(90deg) translateX(0);
    }
    25%,40% {
      opacity: 1;
      transform: rotate(90deg) translateX(4px);
    }
  }
}
@media(prefers-reduced-motion:reduce) {
  .image-camera *,.local-flow * {
    animation: none!important;
  }
  .image-camera .pointer,.image-camera .attach-menu,.image-camera .send-generating,.image-camera .draft-attachment,.image-camera .draft-prompt {
    display: none;
  }
  .image-camera .thread-messages {
    transform: translateY(var(--thread-rest-y));
  }
  .image-camera .chat-scene :deep(.chat-input-send) {
    animation: none!important;
    background: var(--surface-2);
    color: var(--subtle);
  }
}
</style>
