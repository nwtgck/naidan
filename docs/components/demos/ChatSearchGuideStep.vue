<script setup lang="ts">
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CornerDownRightIcon, CopyIcon, FilterIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, MessageSquareIcon, MoreHorizontalIcon, MoreVerticalIcon, MousePointer2Icon, PanelLeftIcon, PencilIcon, SearchIcon, SettingsIcon, SquarePenIcon, XIcon } from 'lucide-vue-next';
import NaidanChatInput from './NaidanChatInput.vue';
import type { ChatSearchGuideMessages } from '../../messages/types';

// Independent replicas of Sidebar, ChatGroupActions, ChatPaneHeader,
// GlobalSearchModal, SearchPreview and MessageItem. The page owns the timeline.
const { messages } = defineProps<{
  stage: 'find' | 'group' | 'chat' | 'open';
  messages: ChatSearchGuideMessages;
  chrome: Readonly<typeof import('../../messages/replica-chrome/en').messages>;
}>();
const characters = [...messages.search_keyword].map((character, index, all) => ({ character, delay: `${(index * 1.2 / Math.max(all.length - 1, 1)).toFixed(3)}s` }));
const matchParts = messages.match_text.split(messages.search_keyword);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="search-camera" :class="`stage-${stage}`" :data-docs-animation="`chat-search-${stage}`" :data-testid="`chat-search-step-${stage}`" aria-hidden="true">
    <div class="app-canvas">
      <aside class="app-sidebar">
        <div class="sidebar-actions">
          <span class="new-chat"><SquarePenIcon :size="15" />{{ messages.new_chat }}</span>
          <span class="sidebar-search icon-action" :title="messages.search" data-testid="chat-search-sidebar-entry"><SearchIcon :size="16" /><MousePointer2Icon v-if="stage === 'find'" class="pointer entry-pointer" :size="20" /></span>
          <span class="icon-action" :title="messages.create_chat_group"><FolderPlusIcon :size="16" /></span>
        </div>
        <div class="group-row"><ChevronDownIcon :size="13" /><FolderIcon :size="15" /><strong>{{ messages.chat_group }}</strong><span class="group-more" :title="messages.more_actions"><MoreHorizontalIcon :size="16" /><MousePointer2Icon v-if="stage === 'group'" class="pointer entry-pointer" :size="20" /></span></div>
        <div class="sidebar-chat active"><MessageSquareIcon :size="13" />{{ messages.chat_title }}</div>
        <div class="sidebar-chat"><MessageSquareIcon :size="13" />{{ messages.other_chat }}</div>
        <div v-if="stage === 'group'" class="entry-menu group-menu" data-testid="chat-search-group-entry">
          <span><PencilIcon :size="14" />{{ messages.rename_group }}</span>
          <strong class="search-choice"><SearchIcon :size="14" />{{ messages.search_in_group }}<MousePointer2Icon class="pointer choice-pointer" :size="20" /></strong>
          <span><CopyIcon :size="14" />{{ messages.duplicate_group }}</span>
        </div>
        <div class="sidebar-settings"><SettingsIcon :size="14" />{{ messages.settings }}</div>
      </aside>
      <div class="app-main">
        <div class="chat-header"><PanelLeftIcon :size="16" /><strong>{{ messages.chat_title }}</strong><span class="header-more" :title="messages.more_actions"><MoreVerticalIcon :size="17" /><MousePointer2Icon v-if="stage === 'chat'" class="pointer entry-pointer" :size="20" /></span></div>
        <div v-if="stage === 'chat'" class="entry-menu chat-menu" data-testid="chat-search-chat-entry"><span>{{ messages.chat_settings }}</span><strong class="search-choice"><SearchIcon :size="14" />{{ messages.search_in_chat }}<MousePointer2Icon class="pointer choice-pointer" :size="20" /></strong></div>
        <div class="conversation">
          <div class="user-message">{{ messages.question }}</div>
          <div class="answer-stack">
            <p class="current-answer">{{ messages.current_answer }}</p>
            <div class="opened-match" data-testid="chat-search-opened-message"><p>{{ messages.match_text }}</p><span class="message-actions"><CopyIcon :size="13" /><PencilIcon :size="13" /><span class="branch-navigation"><ChevronLeftIcon :size="13" />1 / 2<ChevronRightIcon :size="13" /></span></span></div>
          </div>
        </div>
        <div class="composer-position"><NaidanChatInput :messages="chrome" :model="messages.model" status="idle" /></div>
      </div>
    </div>

    <div class="search-overlay">
      <div class="search-modal" data-testid="chat-search-modal">
        <div class="search-input"><SearchIcon :size="18" /><span class="query"><span class="query-placeholder">{{ messages.search_placeholder }}</span><span class="query-text"><span v-for="(item, index) in characters" :key="index" class="query-character" :style="{ '--character-delay': item.delay }">{{ item.character }}</span></span></span><span class="close-search"><kbd>ESC</kbd><XIcon :size="15" /></span></div>
        <div class="search-options">
          <div class="option-row"><div class="scope-options"><strong>{{ messages.all }}</strong><span>{{ messages.current_thread }}</span><span>{{ messages.title_only }}</span></div><span class="role-filter">{{ messages.role }}<span>{{ messages.all }}<ChevronDownIcon :size="11" /></span></span></div>
          <div class="option-row filter-row"><span class="groups-control"><FilterIcon :size="13" />{{ messages.groups }}</span><span v-if="stage === 'group' || stage === 'chat'" class="target-filter" data-testid="chat-search-target-filter"><FolderIcon v-if="stage === 'group'" :size="12" /><MessageSquareIcon v-else :size="12" />{{ stage === 'group' ? messages.chat_group : messages.chat_title }}<XIcon :size="11" /></span><span class="preview-controls">{{ messages.preview }}<strong>{{ messages.on }}</strong><span>{{ messages.peek }}</span><span>{{ messages.off }}</span></span></div>
        </div>
        <div class="search-body">
          <div class="result-list">
            <div class="chat-result"><MessageSquareIcon :size="17" /><div><strong>{{ messages.chat_title }}</strong><span><FolderIcon :size="11" />{{ messages.chat_group }}</span></div></div>
            <div class="message-result" data-testid="chat-search-message-result"><CornerDownRightIcon :size="14" /><div><span class="message-role">{{ messages.assistant_role }}</span><p><template v-for="(part, index) in matchParts" :key="index"><mark v-if="index > 0">{{ messages.search_keyword }}</mark>{{ part }}</template></p><span class="alt-branch"><GitBranchIcon :size="12" />{{ messages.alt_branch }}</span></div><MousePointer2Icon v-if="stage === 'open'" class="pointer result-pointer" :size="21" /></div>
          </div>
          <div class="search-preview"><div class="preview-title">{{ messages.conversation_match }}<span class="alt-branch"><GitBranchIcon :size="12" />{{ messages.alt_branch }}</span></div><p class="preview-question">{{ messages.question }}</p><p class="preview-match"><template v-for="(part, index) in matchParts" :key="index"><mark v-if="index > 0">{{ messages.search_keyword }}</mark>{{ part }}</template></p></div>
        </div>
        <div class="search-footer"><span><kbd>↑↓</kbd>{{ messages.navigate }}</span><span><kbd>↵</kbd>{{ messages.select }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-camera {
  --search-branch: #d9a257;
  position: relative;
  height: 390px;
  max-width: 720px;
  margin-inline: auto;
  overflow: hidden;
  container-type: inline-size;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--bg);
  box-shadow: var(--panel-shadow);
  color: var(--text);
  font: 12px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.app-canvas {
  position: absolute;
  left: 0;
  top: 0;
  display: grid;
  grid-template-columns: 248px 472px;
  width: 720px;
  height: 390px;
}
.app-sidebar {
  position: relative;
  padding: 12px 10px;
  background: var(--surface-2);
  border-right: 1px solid var(--line);
}
.sidebar-actions,.group-row,.sidebar-chat,.sidebar-settings,.chat-header,.icon-action,.new-chat,.entry-menu span,.entry-menu strong {
  display: flex;
  align-items: center;
  gap: 7px;
}
.sidebar-actions {
  gap: 6px;
}
.new-chat {
  flex: 1;
  justify-content: center;
  height: 33px;
  border-radius: 9px;
  background: var(--blue-strong);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}
.icon-action {
  position: relative;
  flex: none;
  justify-content: center;
  width: 33px;
  height: 33px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--muted);
}
.group-row {
  margin-top: 23px;
  padding: 7px 4px;
}
.group-row strong {
  flex: 1;
}
.group-more,.header-more {
  position: relative;
  display: flex;
  padding: 4px;
  color: var(--muted);
}
.sidebar-chat {
  margin-left: 19px;
  padding: 8px;
  border-radius: 7px;
  color: var(--muted);
}
.sidebar-chat.active {
  background: color-mix(in srgb,var(--blue) 10%,transparent);
  color: var(--blue);
}
.sidebar-settings {
  position: absolute;
  bottom: 15px;
  left: 18px;
  color: var(--muted);
}
.app-main {
  position: relative;
  min-width: 0;
}
.chat-header {
  height: 52px;
  padding: 9px 15px;
  border-bottom: 1px solid var(--line);
}
.chat-header strong {
  flex: 1;
  font-size: 13px;
}
.conversation {
  padding: 23px;
}
.user-message {
  width: fit-content;
  max-width: 90%;
  margin-left: auto;
  padding: 9px 13px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-2);
}
.answer-stack {
  display: grid;
  margin-top: 19px;
}
.current-answer,.opened-match {
  grid-area: 1 / 1;
  margin: 0;
}
.opened-match {
  opacity: 0;
}
.opened-match p {
  margin: 0;
}
.message-actions,.branch-navigation {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
}
.message-actions {
  margin-top: 13px;
}
.branch-navigation {
  gap: 6px;
  margin-left: 8px;
  font-size: 10px;
}
.composer-position {
  position: absolute;
  left: 19px;
  right: 19px;
  bottom: 14px;
}
.pointer {
  position: absolute;
  z-index: 4;
  color: var(--text);
  fill: var(--surface);
  filter: drop-shadow(0 2px 2px #0006);
}
.entry-pointer {
  right: -3px;
  top: 18px;
  animation: entry-pointer 12s linear infinite;
}
.entry-menu {
  position: absolute;
  z-index: 3;
  padding: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface);
  box-shadow: var(--panel-shadow);
  opacity: 0;
  animation: entry-menu 12s linear infinite;
}
.entry-menu span,.entry-menu strong {
  min-height: 33px;
  padding: 5px 9px;
  font-size: 11px;
  font-weight: 500;
}
.entry-menu svg {
  flex: none;
}
.entry-menu .search-choice {
  position: relative;
  color: var(--blue);
  background: color-mix(in srgb,var(--blue) 10%,transparent);
  border-radius: 6px;
}
.choice-pointer {
  right: 4px;
  bottom: -7px;
  animation: choice-pointer 12s linear infinite;
}
.group-menu {
  top: 107px;
  left: 10px;
  width: 226px;
}
.chat-menu {
  right: 13px;
  top: 46px;
  width: 206px;
}
.search-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  padding: 13px;
  background: #0005;
  opacity: 0;
  animation: search-overlay 12s linear infinite;
}
.search-modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--bg);
  box-shadow: var(--panel-shadow);
}
.search-input {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 53px;
  padding: 10px 15px;
  border-bottom: 1px solid var(--line);
}
.search-input > svg {
  flex: none;
  color: var(--blue);
}
.query {
  display: grid;
  flex: 1;
  min-width: 0;
  font-size: 15px;
}
.query-placeholder,.query-text {
  grid-area: 1 / 1;
  overflow-wrap: anywhere;
}
.query-placeholder {
  color: var(--subtle);
  opacity: 0;
}
.query-character {
  opacity: 1;
}
.close-search {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--subtle);
}
kbd {
  padding: 1px 4px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  font: 10px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.search-options {
  display: grid;
  gap: 8px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
  font-size: 10px;
}
.option-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 13px;
}
.scope-options {
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
  padding: 2px;
  border-radius: 7px;
  background: var(--surface);
  color: var(--muted);
}
.scope-options span,.scope-options strong {
  padding: 4px 7px;
  font-weight: 500;
}
.scope-options strong,.preview-controls strong {
  color: var(--text);
  border-radius: 5px;
  background: var(--bg);
  box-shadow: 0 0 0 1px var(--line);
}
.role-filter,.role-filter > span,.groups-control,.target-filter,.preview-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.role-filter > span {
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}
.target-filter {
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb,var(--blue) 28%,transparent);
  border-radius: 6px;
  background: color-mix(in srgb,var(--blue) 8%,transparent);
  color: var(--blue);
}
.preview-controls {
  gap: 2px;
  margin-left: auto;
  font-size: 9px;
}
.preview-controls strong,.preview-controls > span {
  padding: 3px 5px;
  font-weight: 500;
}
.search-body {
  display: grid;
  grid-template-columns: minmax(0,3fr) minmax(0,2fr);
  flex: 1;
  min-height: 0;
}
.result-list {
  min-width: 0;
  padding: 10px;
}
.chat-result {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
}
.chat-result > svg {
  flex: none;
  color: var(--muted);
}
.chat-result strong {
  display: block;
  font-size: 12px;
  font-weight: 600;
}
.chat-result span {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 10px;
}
.message-result {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 4px;
  padding: 9px 10px 9px 18px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-2);
}
.message-result > svg:not(.pointer) {
  flex: none;
  margin-top: 3px;
  color: var(--subtle);
}
.message-role {
  color: var(--muted);
  font-size: 10px;
}
.message-result p,.search-preview p {
  margin: 4px 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
mark {
  background: color-mix(in srgb,var(--blue) 22%,transparent);
  color: var(--text);
  border-radius: 2px;
}
.alt-branch {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--search-branch);
  font-size: 9px;
}
.search-preview {
  min-width: 0;
  border-left: 1px solid var(--line);
  background: var(--surface);
}
.preview-title {
  padding: 8px 11px;
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  color: var(--muted);
}
.preview-title .alt-branch {
  margin-top: 3px;
}
.search-preview .preview-question {
  margin: 10px;
  padding: 7px;
  border-radius: 8px;
  background: var(--surface-2);
}
.search-preview .preview-match {
  padding: 7px 10px;
  background: color-mix(in srgb,var(--blue) 7%,transparent);
}
.search-footer {
  display: flex;
  flex: none;
  gap: 17px;
  padding: 7px 13px;
  border-top: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 10px;
}
.search-footer > span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.result-pointer {
  right: 11px;
  bottom: 10px;
  animation: result-pointer 12s linear infinite;
}
.stage-find .query-placeholder {
  animation: query-placeholder 12s linear infinite;
}
.stage-find .query-character {
  animation: query-character 12s linear var(--character-delay) infinite both;
}
.stage-find .search-body {
  animation: results-arrive 12s linear infinite;
}
.stage-chat .app-canvas {
  left: min(0px,calc(100cqw - 720px));
}
.stage-chat .chat-header {
  /* Keep the header content 18px inside the camera when the 472px main pane is cropped. */
  padding-left: max(15px,calc(490px - 100cqw));
}
.stage-open .search-overlay {
  animation-name: open-result;
}
.stage-open .current-answer {
  opacity: 0;
}
.stage-open .opened-match {
  opacity: 1;
}
.stage-open .app-canvas {
  grid-template-columns: 0 minmax(0,1fr);
  width: 100cqw;
}
.stage-open .app-sidebar {
  visibility: hidden;
  padding: 0;
}
.stage-open .app-main {
  min-width: 0;
}
html[data-theme="light"] .search-camera,
html:has(#docs-light-theme:checked) .search-camera {
  --search-branch: #92400e;
}
@keyframes entry-pointer {
  0%,4% {
    opacity: 0;
    transform: translate(12px,10px);
  }
  8%,15% {
    opacity: 1;
    transform: translate(0,0);
  }
  19%,100% {
    opacity: 0;
    transform: translate(0,0);
  }
}
@keyframes entry-menu {
  0%,12% {
    opacity: 0;
  }
  17%,28% {
    opacity: 1;
  }
  33%,100% {
    opacity: 0;
  }
}
@keyframes choice-pointer {
  0%,19% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  23%,28% {
    opacity: 1;
    transform: translate(0,0);
  }
  33%,100% {
    opacity: 0;
    transform: translate(0,0);
  }
}
@keyframes search-overlay {
  0%,30% {
    opacity: 0;
  }
  35%,92% {
    opacity: 1;
  }
  97%,100% {
    opacity: 0;
  }
}
@keyframes query-placeholder {
  0%,36% {
    opacity: 1;
  }
  37%,100% {
    opacity: 0;
  }
}
@keyframes query-character {
  0%,37% {
    opacity: 0;
  }
  37.1%,100% {
    opacity: 1;
  }
}
@keyframes results-arrive {
  0%,49% {
    opacity: 0;
  }
  54%,100% {
    opacity: 1;
  }
}
@keyframes open-result {
  0%,30% {
    opacity: 1;
  }
  36%,92% {
    opacity: 0;
  }
  97%,100% {
    opacity: 1;
  }
}
@keyframes result-pointer {
  0%,8% {
    opacity: 0;
    transform: translate(12px,8px);
  }
  15%,27% {
    opacity: 1;
    transform: translate(0,0);
  }
  31%,100% {
    opacity: 0;
    transform: translate(0,0);
  }
}
html:has(#docs-pause-motion:checked) .search-camera *,
html:has(#docs-pause-motion:checked) .search-camera *::after {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .search-camera .search-overlay,
html:has(#docs-pause-motion:checked) .search-camera .search-body,
html:has(#docs-pause-motion:checked) .search-camera .query-character {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .search-camera .pointer,
html:has(#docs-pause-motion:checked) .search-camera .entry-menu,
html:has(#docs-pause-motion:checked) .search-camera .query-placeholder,
html:has(#docs-pause-motion:checked) .stage-open .search-overlay {
  opacity: 0;
}
@container(max-width:560px) {
  .search-overlay {
    padding: 10px;
  }
  .app-canvas {
    height: 390px;
  }
  .role-filter {
    width: 100%;
  }
  .preview-controls {
    margin-left: 0;
  }
  .search-body {
    grid-template-columns: minmax(0,1fr);
  }
  .search-preview {
    display: none;
  }
  .close-search kbd {
    display: none;
  }
  .query {
    font-size: 13px;
  }
  .search-options {
    padding: 8px;
  }
  .scope-options span,.scope-options strong {
    padding-inline: 5px;
  }
  .message-result {
    padding-left: 10px;
  }
  .stage-open .conversation {
    padding: 18px;
  }
  .stage-open .user-message {
    max-width: 100%;
  }
  .stage-open .composer-position {
    left: 12px;
    right: 12px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .search-camera *,.search-camera *::after {
    animation: none!important;
  }
  .search-camera .search-overlay,.search-camera .search-body,.search-camera .query-character {
    opacity: 1;
  }
  .search-camera .pointer,.search-camera .entry-menu,.search-camera .query-placeholder,.stage-open .search-overlay {
    opacity: 0;
  }
}
</style>
