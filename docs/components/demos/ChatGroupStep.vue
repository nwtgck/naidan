<script setup lang="ts">
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderInputIcon, FolderPlusIcon, MessageSquarePlusIcon, MoreVerticalIcon, MousePointer2Icon, PencilIcon, SearchIcon, SquarePenIcon, XIcon } from 'lucide-vue-next';

defineProps<{ stage: 'create' | 'move' | 'add' | 'tidy'; messages: typeof import('../../pages/chat-groups/messages/en').messages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="group-viewport" :class="`stage-${stage}`" :data-docs-animation="`group-${stage}`" :data-testid="`group-step-${stage}`" aria-hidden="true">
    <div class="group-canvas">
      <aside class="app-sidebar">
        <div class="sidebar-actions"><span class="new-chat"><SquarePenIcon :size="15" />{{ messages.new_chat }}</span><span class="icon-action" :title="messages.search"><SearchIcon :size="15" /></span><span class="icon-action create-button" :title="messages.create_chat_group"><FolderPlusIcon :size="15" /><MousePointer2Icon v-if="stage === 'create'" class="pointer" :size="18" /></span></div>
        <div class="creation-row"><FolderIcon :size="14" /><span class="entry-name"><span class="entry-placeholder">{{ messages.group_name }}</span><strong class="entry-value">{{ messages.translation }}</strong></span><CheckIcon :size="16" :title="messages.create_group" /><MousePointer2Icon v-if="stage === 'create'" class="pointer confirm-pointer" :size="18" /></div>
        <div class="group-block"><div class="group-row"><ChevronDownIcon class="group-chevron" :size="14" /><MousePointer2Icon v-if="stage === 'tidy'" class="pointer collapse-pointer" :size="18" /><FolderIcon :size="16" /><strong class="name-stack"><span class="old-name">{{ messages.translation }}</span><span class="new-name">{{ messages.english_translation }}</span></strong><span class="rename-input">{{ messages.english_translation }}<CheckIcon :size="13" /></span><PencilIcon class="rename-pencil" :title="messages.rename_group" :size="14" /><MousePointer2Icon v-if="stage === 'tidy'" class="pointer rename-pointer" :size="18" /></div>
          <div class="nested-items"><div class="add-chat"><MessageSquarePlusIcon :size="13" />{{ messages.add_chat }}<MousePointer2Icon v-if="stage === 'add'" class="pointer add-pointer" :size="18" /></div><div class="nested-chat first-chat">{{ messages.page_copy }}</div><div class="nested-chat second-chat">{{ messages.new_chat }}</div></div>
        </div>
        <div class="top-chat">{{ messages.page_copy }}</div>
      </aside>
      <div class="app-main"><div class="chat-header"><strong class="title-stack"><span class="old-title">{{ messages.page_copy }}</span><span class="new-title">{{ messages.new_chat }}</span></strong><div class="header-actions"><span class="move-button" :title="messages.move_to_group"><FolderInputIcon :size="17" /><MousePointer2Icon v-if="stage === 'move'" class="pointer" :size="18" /></span><MoreVerticalIcon :size="17" /></div></div><div class="chat-body"><p class="user-message">{{ messages.translate_this_paragraph_into_english }}</p><p class="assistant-message">{{ messages.i_will_translate_it_while_keeping_the_meaning }}</p></div><div class="chat-input">{{ messages.type_a_message }}</div>
        <div class="move-menu"><strong>{{ messages.move_to_group }}</strong><span><XIcon :size="14" />{{ messages.top_level }}</span><span class="group-option"><FolderIcon :size="14" />{{ messages.translation }}<ChevronRightIcon :size="13" /><MousePointer2Icon v-if="stage === 'move'" class="pointer menu-pointer" :size="18" /></span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.group-viewport {
  --move-x:-68px;
  --add-x:-80px;
  height: 285px;
  max-width: 650px;
  margin-inline: auto;
  position: relative;
  container-type: inline-size;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: var(--panel-shadow);
  color: var(--text);
  font: 11px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.group-canvas {
  position: absolute;
  inset: 0 auto auto 0;
  width: 760px;
  height: 285px;
  display: grid;
  grid-template-columns: 248px 512px;
}
.app-sidebar {
  position: relative;
  min-width: 0;
  height: 285px;
  padding: 11px 10px;
  background: var(--surface-2);
  border-right: 1px solid var(--line);
}
.sidebar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.new-chat {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  height: 31px;
  border-radius: 7px;
  background: var(--blue-strong);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
}
.new-chat svg {
  flex: none;
}
.icon-action {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 31px;
  height: 31px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--muted);
}
.pointer {
  position: absolute;
  right: -7px;
  bottom: -8px;
  z-index: 5;
  color: var(--text);
  fill: var(--surface);
  filter: drop-shadow(0 1px 2px #0009);
}
.creation-row,.group-row {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 53px;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 37px;
  padding: 5px 7px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}
.creation-row {
  z-index: 2;
  background: color-mix(in srgb,var(--blue) 8%,var(--surface));
  opacity: 0;
}
.entry-name {
  display: grid;
  flex: 1;
  min-width: 0;
  padding: 2px 5px;
  border: 1px solid var(--blue);
  border-radius: 4px;
  background: var(--surface);
  font-weight: 800;
}
.entry-name > * {
  grid-area: 1/1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.entry-placeholder {
  color: var(--muted);
}
.entry-value {
  opacity: 0;
}
.creation-row > svg:nth-last-child(2) {
  color: var(--green);
}
.group-block {
  opacity: 1;
}
.group-row {
  color: var(--blue);
  background: color-mix(in srgb,var(--blue) 9%,var(--surface-2));
}
.group-row > svg {
  flex: none;
}
.group-row .collapse-pointer {
  left: 16px;
  right: auto;
  top: 24px;
  bottom: auto;
  animation: collapse-pointer 9s linear infinite;
}
.name-stack {
  display: grid;
  flex: 1;
  min-width: 0;
}
.name-stack span {
  grid-area: 1/1;
  overflow-wrap: anywhere;
}
.new-name {
  opacity: 0;
}
.rename-input {
  position: absolute;
  left: 43px;
  right: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 3px 5px;
  border: 1px solid var(--blue);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text);
  opacity: 0;
}
.rename-pencil {
  color: var(--muted);
}
.rename-pointer {
  animation: rename-pointer 9s linear infinite;
}
.nested-items {
  position: absolute;
  left: 27px;
  right: 10px;
  top: 95px;
  display: grid;
  gap: 4px;
  padding-left: 9px;
  border-left: 1px solid var(--line-strong);
  transform-origin: top left;
}
.nested-items > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.add-chat {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px;
  color: var(--muted);
  font-size: 10px;
}
.add-chat svg {
  flex: none;
}
.nested-chat {
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--surface);
}
.first-chat,.second-chat {
  opacity: 0;
}
.top-chat {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 218px;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--surface);
}
.app-main {
  position: relative;
  min-width: 0;
  height: 285px;
  background: var(--surface);
}
.chat-header {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 17px;
  border-bottom: 1px solid var(--line);
}
.title-stack {
  display: grid;
  min-width: 0;
  font-size: 13px;
}
.title-stack span {
  grid-area: 1/1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.new-title {
  opacity: 0;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 13px;
  color: var(--muted);
}
.move-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
}
.chat-body {
  display: grid;
  gap: 10px;
  padding: 16px 18px;
}
.chat-body p {
  width: max-content;
  max-width: 85%;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.user-message {
  justify-self: end;
  background: var(--surface-2);
}
.assistant-message {
  justify-self: start;
  color: var(--muted);
}
.chat-input {
  position: absolute;
  left: 17px;
  right: 17px;
  bottom: 14px;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--muted);
}
.move-menu {
  position: absolute;
  z-index: 3;
  right: 20px;
  top: 46px;
  width: 220px;
  padding: 5px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--surface-2);
  box-shadow: 0 12px 29px #0005;
  opacity: 0;
}
.move-menu > * {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.move-menu > strong {
  color: var(--muted);
  font-size: 9px;
}
.group-option {
  position: relative;
  color: var(--blue);
  border-radius: 6px;
  background: color-mix(in srgb,var(--blue) 12%,var(--surface-2));
}
.group-option > svg:nth-last-child(2) {
  margin-left: auto;
}
.stage-create .group-block {
  opacity: 0;
  animation: group-created 9s linear infinite;
}
.stage-create .creation-row {
  animation: creation-field 9s linear infinite;
}
.stage-create .entry-placeholder {
  animation: placeholder-leave 9s linear infinite;
}
.stage-create .entry-value {
  animation: entry-arrive 9s linear infinite;
}
.stage-create .create-button .pointer {
  animation: create-pointer 9s linear infinite;
}
.stage-create .confirm-pointer {
  animation: confirm-pointer 9s linear infinite;
}
.stage-move .group-canvas {
  animation: camera-move 9s linear infinite;
}
.stage-move .move-button .pointer {
  animation: move-pointer 9s linear infinite;
}
.stage-move .move-menu {
  animation: menu-open 9s linear infinite;
}
.stage-move .menu-pointer {
  animation: option-pointer 9s linear infinite;
}
.stage-move .top-chat {
  animation: top-leave 9s linear infinite;
}
.stage-move .first-chat {
  animation: first-arrive 9s linear infinite;
}
.stage-add .top-chat,.stage-tidy .top-chat {
  opacity: 0;
}
.stage-add .first-chat,.stage-tidy .first-chat {
  opacity: 1;
}
.stage-add .second-chat {
  animation: second-arrive 9s linear infinite;
}
.stage-add .new-title {
  animation: title-arrive 9s linear infinite;
}
.stage-add .old-title {
  animation: title-leave 9s linear infinite;
}
.stage-add .chat-body {
  animation: chat-body-leave 9s linear infinite;
}
.stage-add .add-pointer {
  animation: add-pointer 9s linear infinite;
}
.stage-add .group-canvas {
  animation: camera-add 9s linear infinite;
}
.stage-tidy .first-chat,.stage-tidy .second-chat {
  opacity: 1;
}
.stage-tidy .new-title {
  opacity: 1;
}
.stage-tidy .old-title,.stage-tidy .chat-body {
  opacity: 0;
}
.stage-tidy .new-name {
  animation: name-arrive 9s linear infinite;
}
.stage-tidy .old-name {
  animation: name-leave 9s linear infinite;
}
.stage-tidy .rename-input {
  animation: rename-field 9s linear infinite;
}
.stage-tidy .nested-items {
  animation: collapse-items 9s linear infinite;
}
.stage-tidy .group-chevron {
  animation: chevron-collapse 9s linear infinite;
}
@keyframes creation-field {
  0%,18%,67%,100% {
    opacity: 0;
    transform: translateY(-5px);
  }
  29%,56% {
    opacity: 1;
    transform: none;
  }
}
@keyframes placeholder-leave {
  0%,32% {
    opacity: 1;
  }
  40%,100% {
    opacity: 0;
  }
}
@keyframes entry-arrive {
  0%,32% {
    opacity: 0;
  }
  40%,100% {
    opacity: 1;
  }
}
@keyframes group-created {
  0%,61% {
    opacity: 0;
    transform: translateY(5px);
  }
  72%,100% {
    opacity: 1;
    transform: none;
  }
}
@keyframes create-pointer {
  0%,7%,27%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  14%,20% {
    opacity: 1;
    transform: none;
  }
}
@keyframes confirm-pointer {
  0%,39%,61%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  46%,53% {
    opacity: 1;
    transform: none;
  }
}
@keyframes camera-move {
  0%,10%,79%,100% {
    transform: none;
  }
  22%,68% {
    transform: translateX(var(--move-x));
  }
}
@keyframes move-pointer {
  0%,13%,37%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  22%,29% {
    opacity: 1;
    transform: none;
  }
}
@keyframes menu-open {
  0%,29%,73%,100% {
    opacity: 0;
    transform: translateY(-5px);
  }
  40%,62% {
    opacity: 1;
    transform: none;
  }
}
@keyframes option-pointer {
  0%,43%,69%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  51%,58% {
    opacity: 1;
    transform: none;
  }
}
@keyframes top-leave {
  0%,66% {
    opacity: 1;
  }
  77%,100% {
    opacity: 0;
  }
}
@keyframes first-arrive {
  0%,66% {
    opacity: 0;
  }
  77%,100% {
    opacity: 1;
  }
}
@keyframes second-arrive {
  0%,41% {
    opacity: 0;
    transform: translateY(-4px);
  }
  53%,100% {
    opacity: 1;
    transform: none;
  }
}
@keyframes title-arrive {
  0%,41% {
    opacity: 0;
  }
  53%,100% {
    opacity: 1;
  }
}
@keyframes title-leave {
  0%,41% {
    opacity: 1;
  }
  53%,100% {
    opacity: 0;
  }
}
@keyframes chat-body-leave {
  0%,41% {
    opacity: 1;
  }
  53%,100% {
    opacity: 0;
  }
}
@keyframes add-pointer {
  0%,12%,37%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  20%,28% {
    opacity: 1;
    transform: none;
  }
}
@keyframes camera-add {
  0%,47%,90%,100% {
    transform: none;
  }
  58%,79% {
    transform: translateX(var(--add-x));
  }
}
@keyframes rename-pointer {
  0%,9%,32%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  17%,24% {
    opacity: 1;
    transform: none;
  }
}
@keyframes collapse-pointer {
  0%,57%,77%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  64%,70% {
    opacity: 1;
    transform: none;
  }
}
@keyframes rename-field {
  0%,28%,59%,100% {
    opacity: 0;
  }
  36%,51% {
    opacity: 1;
  }
}
@keyframes name-arrive {
  0%,56% {
    opacity: 0;
  }
  66%,100% {
    opacity: 1;
  }
}
@keyframes name-leave {
  0%,56% {
    opacity: 1;
  }
  66%,100% {
    opacity: 0;
  }
}
@keyframes collapse-items {
  0%,61% {
    opacity: 1;
    transform: none;
  }
  74%,100% {
    opacity: 0;
    transform: scaleY(.85);
  }
}
@keyframes chevron-collapse {
  0%,61% {
    transform: none;
  }
  74%,100% {
    transform: rotate(-90deg);
  }
}
html:has(#docs-pause-motion:checked) .group-viewport * {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .stage-create .group-block,html:has(#docs-pause-motion:checked) .stage-move .first-chat,html:has(#docs-pause-motion:checked) .stage-add .second-chat,html:has(#docs-pause-motion:checked) .stage-add .new-title,html:has(#docs-pause-motion:checked) .stage-tidy .new-name {
  opacity: 1;
  transform: none;
}
html:has(#docs-pause-motion:checked) .stage-create .creation-row,html:has(#docs-pause-motion:checked) .stage-move .top-chat,html:has(#docs-pause-motion:checked) .stage-add .old-title,html:has(#docs-pause-motion:checked) .stage-add .chat-body,html:has(#docs-pause-motion:checked) .stage-tidy .old-name,html:has(#docs-pause-motion:checked) .stage-tidy .nested-items {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .stage-tidy .group-chevron {
  transform: rotate(-90deg);
}
html:has(#docs-pause-motion:checked) .group-viewport .pointer {
  display: none;
}
@media(prefers-reduced-motion:reduce) {
  .group-viewport * {
    animation: none!important;
  }
  .stage-create .group-block,.stage-move .first-chat,.stage-add .second-chat,.stage-add .new-title,.stage-tidy .new-name {
    opacity: 1;
    transform: none;
  }
  .stage-create .creation-row,.stage-move .top-chat,.stage-add .old-title,.stage-add .chat-body,.stage-tidy .old-name,.stage-tidy .nested-items {
    opacity: 0;
  }
  .stage-tidy .group-chevron {
    transform: rotate(-90deg);
  }
  .group-viewport .pointer {
    display: none;
  }
}
@container (max-width:650px) {
  .group-canvas {
    --move-x:calc(100cqw - 725px);
    --add-x:-230px;
  }
  .move-menu {
    right: 49px;
  }
}
</style>
