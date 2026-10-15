<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { BirdIcon, UserIcon, CopyIcon, PencilIcon, RefreshCwIcon, GitForkIcon, SendIcon, MoreVerticalIcon, MoreHorizontalIcon, ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon, FileEditIcon, Settings2Icon, XCircleIcon, Volume2Icon, HistoryIcon, LinkIcon, PaperclipIcon, MessageSquareIcon } from 'lucide-vue-next';
import NaidanAppFrame from '../../components/demos/NaidanAppFrame.vue';
import RenderText from '../../components/RenderText';
import type { BranchingMessages, BranchingChrome } from './messages';

type Method = 'edit' | 'resend' | 'regenerate' | 'fork';
type Stage = 0 | 1 | 2 | 3;
const props = defineProps<{ copy: BranchingMessages; chrome: BranchingChrome; variant: Method }>();
const stages = [0, 1, 2, 3] as const;
const method = ref<Method>(props.variant);
// The server-rendered view is a complete example when scripts or motion are unavailable.
const stage = ref<Stage>(2);

function initialPath({ value }: { value: Method }): { branch: 0 | 1; chat: 'original' | 'fork' } {
  switch (value) {
  case 'fork': return { branch: 0, chat: 'fork' };
  case 'edit':
  case 'resend':
  case 'regenerate': return { branch: 1, chat: 'original' };
  default: { const unreachable: never = value; throw new Error(`Unsupported branching method: ${unreachable}`); }
  }
}

const initial = initialPath({ value: props.variant });
const branch = ref<0 | 1>(initial.branch);
const chat = ref<'original' | 'fork'>(initial.chat);

function sidebarFor({ value }: { value: Method }): 'visible' | 'hidden' {
  switch (value) {
  case 'fork': return 'visible';
  case 'edit':
  case 'resend':
  case 'regenerate': return 'hidden';
  default: { const unreachable: never = value; throw new Error(`Unsupported branching method: ${unreachable}`); }
  }
}

const sidebar = sidebarFor({ value: props.variant });
const playback = ref<'automatic' | 'manual'>('automatic');
const availability = ref<'static' | 'interactive'>('static');
const sequence = ref(0);
const draft = ref(props.copy.editedPrompt);
const submittedPrompt = ref(props.copy.editedPrompt);
const forkPrompt = ref(props.copy.prompt);
const forkReply = ref(props.copy.replies[0]);

const reserve = computed(() => {
  switch (props.variant) {
  case 'edit': return { prompts: [props.copy.prompt, props.copy.editedPrompt], replies: [props.copy.replies[0], props.copy.editedReply], userVersions: true, assistantVersions: false };
  case 'resend': return { prompts: [props.copy.prompt], replies: props.copy.replies, userVersions: true, assistantVersions: false };
  case 'regenerate': return { prompts: [props.copy.prompt], replies: props.copy.replies, userVersions: false, assistantVersions: true };
  case 'fork': return { prompts: [props.copy.prompt], replies: [props.copy.replies[0]], userVersions: false, assistantVersions: false };
  default: { const unreachable: never = props.variant; throw new Error(`Unsupported branching method: ${unreachable}`); }
  }
});

const reducedMotion = '(prefers-reduced-motion: reduce)';
let pauseControl: HTMLInputElement | undefined;
let motionQuery: MediaQueryList | undefined;

function motionUnavailable(): boolean {
  return Boolean(document.querySelector<HTMLInputElement>('#docs-pause-motion')?.checked || window.matchMedia?.(reducedMotion).matches);
}

function settleMotion(): void {
  if (playback.value === 'automatic' && motionUnavailable()) {
    showStage({ value: 2 });
    playback.value = 'manual';
  }
}

onMounted(() => {
  pauseControl = document.querySelector<HTMLInputElement>('#docs-pause-motion') ?? undefined;
  motionQuery = window.matchMedia?.(reducedMotion);
  pauseControl?.addEventListener('change', settleMotion);
  motionQuery?.addEventListener('change', settleMotion);
  availability.value = 'interactive';
  if (motionUnavailable()) settleMotion();
  else showStage({ value: 0 });
});

onUnmounted(() => {
  pauseControl?.removeEventListener('change', settleMotion);
  motionQuery?.removeEventListener('change', settleMotion);
});

const editing = computed(() => method.value === 'edit' && stage.value === 1);
const generating = computed(() => (method.value === 'resend' || method.value === 'regenerate') && stage.value === 1);
const hasVersions = computed(() => method.value !== 'fork' && (stage.value >= 2 || generating.value));
const userVersions = computed(() => hasVersions.value && method.value !== 'regenerate');
const assistantVersions = computed(() => hasVersions.value && method.value === 'regenerate');
const hasFork = computed(() => method.value === 'fork' && stage.value >= 2);
const forkOpen = computed(() => hasFork.value && chat.value === 'fork');
const menuOpen = computed(() => method.value === 'fork' && stage.value === 1);
const shownPrompt = computed(() => {
  const value = method.value;
  switch (value) {
  case 'fork': return forkPrompt.value;
  case 'edit': return branch.value === 1 ? submittedPrompt.value : props.copy.prompt;
  case 'resend':
  case 'regenerate': return props.copy.prompt;
  default: { const unreachable: never = value; return unreachable; }
  }
});
const shownReply = computed(() => {
  const value = method.value;
  switch (value) {
  case 'fork': return forkReply.value;
  case 'edit': return branch.value === 1 ? props.copy.editedReply : props.copy.replies[0];
  case 'resend':
  case 'regenerate': return props.copy.replies[branch.value];
  default: { const unreachable: never = value; return unreachable; }
  }
});
const activeTitle = computed(() => forkOpen.value ? props.copy.forkTitle : props.copy.chatTitle);

function showStage({ value }: { value: Stage }): void {
  stage.value = value;
  branch.value = method.value !== 'fork' && (value === 2 || (value === 1 && method.value !== 'edit')) ? 1 : 0;
  chat.value = value === 2 ? 'fork' : 'original';
  if (value === 1 && method.value === 'edit') draft.value = props.copy.editedPrompt;
}

function chooseStage({ value }: { value: Stage }): void {
  playback.value = 'manual';
  showStage({ value });
}

function advance(): void {
  // CSS drives this invisible clock. No independent timer runs.
  if (availability.value !== 'interactive' || playback.value !== 'automatic') return;
  if (motionUnavailable()) {
    settleMotion();
    return;
  }
  const value = stage.value;
  switch (value) {
  case 0: showStage({ value: 1 }); break;
  case 1: showStage({ value: 2 }); break;
  case 2: showStage({ value: 3 }); break;
  case 3: showStage({ value: 0 }); break;
  default: { const unreachable: never = value; throw new Error(`Unsupported walkthrough stage: ${unreachable}`); }
  }
}

function startEdit(): void {
  const existingContent = shownPrompt.value;
  method.value = 'edit';
  playback.value = 'manual';
  showStage({ value: 1 });
  // The real pencil starts with the existing content, not a prewritten revision.
  draft.value = existingContent;
}

function saveEdit(): void {
  if (!draft.value.trim()) {
    cancelEdit();
    return;
  }
  submittedPrompt.value = draft.value;
  playback.value = 'manual';
  showStage({ value: 2 });
}

function cancelEdit(): void {
  playback.value = 'manual';
  showStage({ value: 0 });
}

function createVersion({ value }: { value: 'resend' | 'regenerate' }): void {
  method.value = value;
  playback.value = 'manual';
  showStage({ value: 2 });
}

function selectBranch({ value }: { value: 0 | 1 }): void {
  playback.value = 'manual';
  stage.value = 2;
  branch.value = value;
}

function openMenu(): void {
  if (menuOpen.value) {
    cancelEdit();
    return;
  }
  forkPrompt.value = shownPrompt.value;
  forkReply.value = shownReply.value;
  method.value = 'fork';
  playback.value = 'manual';
  showStage({ value: 1 });
}

function forkChat(): void {
  playback.value = 'manual';
  showStage({ value: 2 });
}

function openChat({ value }: { value: 'original' | 'fork' }): void {
  playback.value = 'manual';
  chat.value = value;
}

function reset(): void {
  playback.value = 'manual';
  const value = method.value;
  switch (value) {
  case 'fork': chat.value = 'original'; break;
  case 'edit':
  case 'resend':
  case 'regenerate': selectBranch({ value: 0 }); break;
  default: { const unreachable: never = value; throw new Error(`Unsupported branching method: ${unreachable}`); }
  }
}

function replay(): void {
  sequence.value += 1;
  forkPrompt.value = props.copy.prompt;
  forkReply.value = props.copy.replies[0];
  submittedPrompt.value = props.copy.editedPrompt;
  const hold = motionUnavailable();
  playback.value = hold ? 'manual' : 'automatic';
  showStage({ value: hold ? 2 : 0 });
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <section class="branch-demo" :aria-label="`${copy.label}: ${copy.methods[method].title}`" :data-testid="`branch-method-${variant}`" data-docs-animation="branch-walkthrough" :data-playback="playback" :data-method="method" :data-stage="stage">
    <h3 class="method-title">{{ copy.methods[method].title }}</h3>
    <p class="method-description">{{ copy.methods[method].body }}</p>
    <NaidanAppFrame :title="activeTitle" address="https://naidan.pages.dev/" :sidebar="sidebar" :messages="chrome">
      <template v-if="variant === 'fork'" #title>
        <span class="branch-title-stack"><span class="branch-title-reserve" aria-hidden="true">{{ copy.forkTitle }}</span><span>{{ activeTitle }}</span></span>
      </template>
      <template v-if="hasFork" #chats>
        <button type="button" class="sample-chat" :class="{ active: forkOpen }" :aria-current="forkOpen ? 'page' : undefined" :aria-label="copy.controls.forkedChat" :disabled="availability === 'static'" data-testid="branch-forked-chat" @click="openChat({ value: 'fork' })"><MessageSquareIcon :size="12" /><span>{{ copy.forkTitle }}</span></button>
        <button type="button" class="sample-chat" :class="{ active: !forkOpen }" :aria-current="!forkOpen ? 'page' : undefined" :aria-label="copy.controls.originalChat" :disabled="availability === 'static'" data-testid="branch-original-chat" @click="openChat({ value: 'original' })"><MessageSquareIcon :size="12" /><span>{{ copy.chatTitle }}</span></button>
      </template>
      <div class="messages" data-testid="branch-conversation">
        <div class="conversation-reserve" aria-hidden="true" inert data-testid="branch-conversation-reserve">
          <div class="reserve-user">
            <div class="message user-message">
              <div class="message-heading"><span class="avatar"><UserIcon :size="16" /></span><span>{{ copy.ui.you }}</span></div>
              <div class="reserve-prompt-stack"><p v-for="text in reserve.prompts" :key="text" class="message-text">{{ text }}</p></div>
              <div class="message-footer">
                <div v-if="reserve.userVersions" class="version-paging"><button type="button" disabled><ChevronLeftIcon :size="12" /></button><span>2 / 2</span><button type="button" disabled><ChevronRightIcon :size="12" /></button></div>
                <div v-else />
                <div class="message-tools"><span v-for="index in 6" :key="index" class="decoration"><MoreHorizontalIcon :size="14" /></span></div>
              </div>
            </div>
            <div v-if="variant === 'edit'" class="message user-message">
              <div class="message-heading"><span class="avatar"><UserIcon :size="16" /></span><span>{{ copy.ui.you }}</span></div>
              <div class="inline-editor">
                <textarea :value="copy.editedPrompt" readonly tabindex="-1" />
                <div class="editor-footer">
                  <span class="editor-tools"><Settings2Icon :size="17" /><FileEditIcon :size="17" /></span>
                  <div class="editor-buttons"><button class="clear-edit" type="button" disabled><XCircleIcon :size="13" />{{ copy.ui.clear }}</button><button type="button" disabled>{{ copy.ui.cancel }}</button><button class="save-edit" type="button" disabled>{{ copy.ui.sendAndBranch }} <kbd>Ctrl + Enter</kbd></button></div>
                </div>
              </div>
            </div>
          </div>
          <div class="message assistant-message">
            <div class="message-heading"><span class="avatar assistant-avatar"><BirdIcon :size="16" /></span><span>Gemma</span><span class="heading-tools"><Volume2Icon :size="12" /><MoreHorizontalIcon :size="13" /></span></div>
            <div class="reserve-replies"><p v-for="text in reserve.replies" :key="text" class="message-text">{{ text }}</p><div class="waiting"><i /><i /><i /></div></div>
            <div class="message-footer">
              <div v-if="reserve.assistantVersions" class="version-paging"><button type="button" disabled><ChevronLeftIcon :size="12" /></button><span>2 / 2</span><button type="button" disabled><ChevronRightIcon :size="12" /></button></div>
              <div v-else />
              <div class="message-tools"><span v-for="index in 6" :key="index" class="decoration"><MoreHorizontalIcon :size="14" /></span></div>
            </div>
          </div>
        </div>
        <div class="conversation-active">
          <div class="message user-message">
            <div class="message-heading"><span class="avatar"><UserIcon :size="16" /></span><span>{{ copy.ui.you }}</span></div>
            <div v-if="editing" class="inline-editor" data-testid="branch-editor">
              <textarea v-model="draft" :aria-label="copy.controls.editor" :disabled="availability === 'static'" data-testid="branch-edit-textarea" @keydown.enter.ctrl.prevent="saveEdit" @keydown.enter.meta.prevent="saveEdit" @keydown.esc.prevent="cancelEdit" />
              <div class="editor-footer">
                <span class="editor-tools" aria-hidden="true"><Settings2Icon :size="17" :title="copy.ui.tools" /><FileEditIcon :size="17" :title="copy.ui.advancedEditor" /></span>
                <div class="editor-buttons">
                  <button v-if="draft" class="clear-edit" type="button" :disabled="availability === 'static'" @click="draft = ''"><XCircleIcon :size="13" />{{ copy.ui.clear }}</button>
                  <button type="button" :disabled="availability === 'static'" @click="cancelEdit">{{ copy.ui.cancel }}</button>
                  <button class="save-edit" type="button" :disabled="availability === 'static'" data-testid="branch-save-edit" @click="saveEdit">{{ copy.ui.sendAndBranch }} <kbd>Ctrl + Enter</kbd></button>
                </div>
              </div>
            </div>
            <template v-else>
              <p class="message-text" data-testid="branch-prompt">{{ shownPrompt }}</p>
              <div class="message-footer">
                <div v-if="userVersions" class="version-paging" data-testid="branch-user-versions">
                  <button type="button" :disabled="availability === 'static' || branch === 0" :aria-label="copy.controls.previousVersion" :title="copy.choices[0]" data-testid="branch-original" @click="selectBranch({ value: 0 })"><ChevronLeftIcon :size="12" /></button>
                  <span>{{ branch + 1 }} / 2</span>
                  <button type="button" :disabled="availability === 'static' || branch === 1" :aria-label="copy.controls.nextVersion" :title="copy.choices[1]" data-testid="branch-alternative" @click="selectBranch({ value: 1 })"><ChevronRightIcon :size="12" /></button>
                </div>
                <div v-else />
                <div class="message-tools">
                  <span class="decoration blue-tool" aria-hidden="true" :title="copy.ui.moreTools"><MoreHorizontalIcon :size="14" /></span>
                  <span class="decoration" aria-hidden="true" :title="copy.ui.readAloud"><Volume2Icon :size="14" /></span>
                  <button v-if="method === 'resend'" type="button" :disabled="availability === 'static'" :aria-label="copy.ui.resend" :title="copy.ui.resend" :class="{ spotlight: stage === 0 }" data-testid="branch-resend" @click="createVersion({ value: 'resend' })"><SendIcon :size="14" /></button>
                  <span v-else class="decoration" aria-hidden="true" :title="copy.ui.resend"><SendIcon :size="14" /></span>
                  <span class="decoration" aria-hidden="true" :title="copy.ui.copy"><CopyIcon :size="14" /></span>
                  <button v-if="method === 'edit'" type="button" :disabled="availability === 'static'" :aria-label="copy.ui.edit" :title="copy.ui.edit" :class="{ spotlight: stage === 0 }" data-testid="branch-edit" @click="startEdit"><PencilIcon :size="14" /></button>
                  <span v-else class="decoration" aria-hidden="true" :title="copy.ui.edit"><PencilIcon :size="14" /></span>
                  <div v-if="method === 'fork'" class="menu-anchor">
                    <button type="button" :disabled="availability === 'static'" :aria-label="copy.ui.moreActions" :title="copy.ui.moreActions" :aria-expanded="menuOpen" :class="{ spotlight: method === 'fork' && stage === 0 }" data-testid="branch-more-actions" @click="openMenu"><MoreVerticalIcon :size="14" /></button>
                    <div v-if="menuOpen" class="message-menu" data-testid="branch-actions-menu">
                      <button type="button" :disabled="availability === 'static'" class="fork-action spotlight" data-testid="branch-fork" @click="forkChat"><GitForkIcon :size="14" /><span>{{ copy.ui.fork }}</span></button>
                      <span><CopyIcon :size="14" />{{ copy.ui.copyRaw }}</span>
                      <span><LinkIcon :size="14" />{{ copy.ui.copyLink }}</span>
                      <span><HistoryIcon :size="14" />{{ copy.ui.compareVersions }}</span>
                    </div>
                  </div>
                  <span v-else class="decoration" aria-hidden="true" :title="copy.ui.moreActions"><MoreVerticalIcon :size="14" /></span>
                </div>
              </div>
            </template>
          </div>
          <div v-if="!forkOpen" class="message assistant-message">
            <div class="message-heading"><span class="avatar assistant-avatar"><BirdIcon :size="16" /></span><span>Gemma</span><span class="heading-tools" aria-hidden="true"><Volume2Icon :size="12" /><MoreHorizontalIcon :size="13" /></span></div>
            <div v-if="generating" class="waiting" aria-hidden="true"><i /><i /><i /></div>
            <p v-else class="message-text" :aria-live="playback === 'manual' ? 'polite' : 'off'" data-testid="branch-reply">{{ shownReply }}</p>
            <div class="message-footer">
              <div v-if="assistantVersions" class="version-paging" data-testid="branch-assistant-versions">
                <button type="button" :disabled="availability === 'static' || branch === 0" :aria-label="copy.controls.previousVersion" :title="copy.choices[0]" data-testid="branch-original" @click="selectBranch({ value: 0 })"><ChevronLeftIcon :size="12" /></button>
                <span>{{ branch + 1 }} / 2</span>
                <button type="button" :disabled="availability === 'static' || branch === 1" :aria-label="copy.controls.nextVersion" :title="copy.choices[1]" data-testid="branch-alternative" @click="selectBranch({ value: 1 })"><ChevronRightIcon :size="12" /></button>
              </div>
              <div v-else />
              <div class="message-tools">
                <span class="decoration blue-tool" aria-hidden="true" :title="copy.ui.moreTools"><MoreHorizontalIcon :size="14" /></span>
                <span class="decoration" aria-hidden="true" :title="copy.ui.readAloud"><Volume2Icon :size="14" /></span>
                <button v-if="method === 'regenerate'" type="button" :disabled="availability === 'static'" :aria-label="copy.ui.regenerate" :title="copy.ui.regenerate" :class="{ spotlight: stage === 0 }" data-testid="branch-regenerate" @click="createVersion({ value: 'regenerate' })"><RefreshCwIcon :size="14" /></button>
                <span v-else class="decoration" aria-hidden="true" :title="copy.ui.regenerate"><RefreshCwIcon :size="14" /></span>
                <span class="decoration" aria-hidden="true" :title="copy.ui.copy"><CopyIcon :size="14" /></span>
                <span class="decoration" aria-hidden="true" :title="copy.ui.edit"><PencilIcon :size="14" /></span>
                <span class="decoration" aria-hidden="true" :title="copy.ui.moreActions"><MoreVerticalIcon :size="14" /></span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="sample-input" aria-hidden="true">
        <div class="input-placeholder">{{ copy.ui.inputPlaceholder }}<span><ChevronDownIcon :size="14" /><FileEditIcon :size="14" /></span></div>
        <div class="input-footer"><span class="model-select">Gemma<ChevronDownIcon :size="11" /></span><PaperclipIcon :size="15" :title="copy.ui.attach" /><Settings2Icon :size="15" :title="copy.ui.tools" /><span class="sample-send" :title="copy.ui.send"><kbd>Ctrl + Enter</kbd><SendIcon :size="14" /></span></div>
      </div>
    </NaidanAppFrame>
    <div class="walkthrough-footer">
      <div class="stage-choices" role="group" :aria-label="copy.controls.steps"><button v-for="value in stages" :key="value" type="button" :disabled="availability === 'static'" :aria-current="stage === value ? 'step' : undefined" :data-testid="`branch-step-${value}`" @click="chooseStage({ value })"><span aria-hidden="true">{{ value + 1 }}</span><span class="sr-only">{{ value + 1 }}. <RenderText :node="copy.methods[method].stages[value]()" /></span></button></div>
      <button type="button" class="replay" :disabled="availability === 'static'" data-testid="branch-replay" @click="replay"><RefreshCwIcon :size="12" />{{ copy.controls.replay }}</button>
    </div>
    <div class="caption-stack">
      <p v-for="(caption, index) in copy.methods[method].stages" :key="index" class="stage-caption caption-reserve" aria-hidden="true"><RenderText :node="caption()" /></p>
      <p class="stage-caption" :aria-live="playback === 'manual' ? 'polite' : 'off'" data-testid="branch-stage-caption"><RenderText :node="copy.methods[method].stages[stage]()" /></p>
    </div>
    <span :key="`${method}-${stage}-${playback}-${sequence}`" class="walkthrough-clock" :class="{ automatic: playback === 'automatic' }" aria-hidden="true" data-testid="branch-clock" @animationiteration="advance" />
    <button class="reset" :class="{ 'reset-reserve': !hasVersions && !hasFork }" type="button" :disabled="availability === 'static' || (!hasVersions && !hasFork)" :aria-hidden="!hasVersions && !hasFork" data-testid="branch-reset" @click="reset">{{ copy.reset }}</button>
  </section>
</template>

<style scoped>
.branch-demo {
  border: 1px solid var(--line-strong);
  border-radius: 20px;
  padding: 14px;
  background: var(--surface);
}

.method-title {
  margin: 0;
  color: var(--text);
  font-size: 16px;
  line-height: 1.4;
}

.branch-title-stack {
  display: grid;
  min-width: 0;
}

.branch-title-stack > * {
  grid-area: 1 / 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.branch-title-reserve {
  visibility: hidden;
}

.branch-demo .method-description {
  margin: 10px 0 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.sample-chat {
  width: 100%;
  border: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 6px;
  background: transparent;
  color: #a4b2c7;
  text-align: left;
  font-size: 10px;
}

.sample-chat svg {
  flex-shrink: 0;
}

.sample-chat span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sample-chat.active {
  background: #253858;
  color: #93c5fd;
  border-radius: 7px;
}

.messages {
  flex: 1;
  display: grid;
  min-width: 0;
}

.conversation-reserve,.conversation-active {
  grid-area: 1 / 1;
  min-width: 0;
}

.conversation-reserve {
  visibility: hidden;
  pointer-events: none;
}

.conversation-reserve .waiting i {
  animation: none;
}

.reserve-user,.reserve-prompt-stack,.reserve-replies {
  display: grid;
  min-width: 0;
}

.reserve-user > *,.reserve-prompt-stack > *,.reserve-replies > * {
  grid-area: 1 / 1;
  min-width: 0;
}

.message {
  min-width: 0;
  padding: 12px;
}

.assistant-message {
  border-block: 1px solid #1f293780;
  background: #1f293733;
}

.message-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  color: #9ca3af;
  font: 700 10px/1.4 ui-sans-serif,system-ui,sans-serif;
}

.user-message .message-heading {
  color: #e5e7eb;
  text-transform: uppercase;
  letter-spacing: .1em;
}

.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid #374151;
  border-radius: 12px;
  background: #1f2937;
  color: #6b7280;
  flex-shrink: 0;
}

.assistant-avatar {
  color: #60a5fa;
}

.heading-tools {
  display: flex;
  gap: 10px;
  color: #6b7280;
}

.branch-demo .message-text {
  margin: 0;
  color: #e5e7eb;
  font-size: 13px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}

.message-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  margin-top: 12px;
  min-height: 28px;
}

.message-tools,.version-paging {
  display: flex;
  align-items: center;
  gap: 4px;
}

.message-tools {
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

.message-tools button,.decoration {
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  padding: 6px;
  background: transparent;
  color: #9ca3af;
}

.message-tools button:hover {
  background: #1f2937;
  color: #60a5fa;
}

.decoration.blue-tool {
  color: #60a5fa66;
}

.version-paging {
  border: 1px solid #374151;
  padding: 2px 5px;
  background: #1f2937;
  border-radius: 8px;
  color: #9ca3af;
  font: 700 10px/1.4 ui-sans-serif,system-ui,sans-serif;
  white-space: nowrap;
}

.version-paging button {
  display: grid;
  place-items: center;
  padding: 4px;
  background: transparent;
  border: 0;
  color: #9ca3af;
}

.version-paging button:disabled {
  opacity: .2;
}

.version-paging span {
  min-width: 38px;
  text-align: center;
}

.inline-editor {
  border: 1px solid #4b5563;
  border-radius: 12px;
  background: #1f2937;
}

.inline-editor textarea {
  display: block;
  width: 100%;
  min-height: 92px;
  resize: vertical;
  border: 0;
  background: transparent;
  color: #f3f4f6;
  padding: 16px;
  font: 13px/1.7 ui-sans-serif,system-ui,sans-serif;
}

.inline-editor:focus-within {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px #3b82f633;
}

.editor-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px 12px;
}

.editor-tools {
  display: flex;
  gap: 16px;
  color: #9ca3af;
}

.editor-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.editor-buttons button {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #9ca3af;
  padding: 6px 8px;
  font: 700 10px/1.5 ui-sans-serif,system-ui,sans-serif;
}

.editor-buttons .clear-edit {
  display: flex;
  align-items: center;
  gap: 5px;
}

.editor-buttons .save-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #2563eb;
  color: #fff;
  border-radius: 12px;
  box-shadow: 0 6px 15px #3b82f633;
}

.editor-buttons kbd,.sample-send kbd {
  font: 9px/1.4 ui-sans-serif,system-ui,sans-serif;
  white-space: nowrap;
}

.editor-buttons kbd {
  padding: 1px 4px;
  border: 1px solid #ffffff33;
  border-radius: 3px;
  opacity: .6;
}

.menu-anchor {
  position: relative;
}

.message-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 192px;
  width: max-content;
  max-width: min(260px,68vw);
  padding: 4px 0;
  background: #1f2937f2;
  border: 1px solid #374151;
  border-radius: 12px;
  box-shadow: 0 15px 25px #0006;
  z-index: 2;
}

.message-menu > span,.message-menu > button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border-radius: 0;
  padding: 6px 12px;
  font-size: 11px;
  line-height: 1.5;
  color: #d1d5db;
  text-align: left;
}

.message-menu svg {
  flex-shrink: 0;
}

.message-menu .fork-action {
  color: #93c5fd;
}

.waiting {
  display: flex;
  gap: 5px;
  align-items: center;
  min-height: 49px;
}

.waiting i {
  width: 5px;
  height: 5px;
  background: #60a5fa;
  border-radius: 50%;
  animation: docs-branch-wait 1.5s ease-in-out infinite;
}

.waiting i:nth-child(2) { animation-delay: .2s; }
.waiting i:nth-child(3) { animation-delay: .4s; }

.sample-input {
  min-width: 0;
  margin: 8px 8px 8px;
  border: 1px solid #374151;
  border-radius: 16px;
  background: #1f2937;
  box-shadow: 0 8px 15px #0002;
}

.input-placeholder {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  min-height: 42px;
  padding: 10px 12px 5px;
  color: #6b7280;
  font-size: 12px;
}

.input-placeholder > span {
  display: grid;
  gap: 8px;
}

.input-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px 7px;
  color: #9ca3af;
}

.model-select {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 68px;
  border: 1px solid #374151;
  border-radius: 7px;
  padding: 6px;
  font-size: 9px;
}

.sample-send {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding: 7px;
  border-radius: 12px;
  background: #2563eb;
  color: #fff;
  opacity: .5;
}

.walkthrough-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
}

.stage-choices {
  display: flex;
  gap: 6px;
}

.stage-choices button {
  width: 28px;
  height: 28px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
}

.stage-choices button[aria-current="step"] {
  background: var(--blue-strong);
  border-color: var(--blue-strong);
  color: #fff;
}

.replay {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 0;
  padding: 5px 0;
  background: transparent;
  color: var(--blue);
  font-size: 11px;
}

.caption-stack {
  display: grid;
}

.caption-stack > * {
  grid-area: 1 / 1;
}

.caption-reserve {
  visibility: hidden;
}

.branch-demo .stage-caption {
  margin: 12px 0;
  color: var(--text);
  font-size: 12px;
  line-height: 1.75;
}

.walkthrough-clock {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.walkthrough-clock.automatic {
  animation: docs-branch-tick 1.7s linear infinite;
}

[data-stage="1"] .walkthrough-clock.automatic { animation-duration: 2.1s; }
[data-stage="2"] .walkthrough-clock.automatic { animation-duration: 3.8s; }
[data-stage="3"] .walkthrough-clock.automatic { animation-duration: 2.4s; }

.spotlight {
  color: #93c5fd !important;
  background: #1e40af66 !important;
  outline: 2px solid #60a5fa88;
  outline-offset: 1px;
}

[data-playback="automatic"] .spotlight {
  animation: docs-branch-focus 2s ease-in-out infinite;
}

.reset {
  margin-top: 14px;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--blue);
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 4px;
}

.reset-reserve {
  visibility: hidden;
}

.branch-demo button:disabled {
  cursor: default;
}

.branch-demo button:focus-visible,.inline-editor textarea:focus-visible {
  outline: 2px solid #60a5fa;
  outline-offset: 2px;
}

@keyframes docs-branch-tick {
  from { opacity: 0; }
  to { opacity: .01; }
}

@keyframes docs-branch-focus {
  0%,100% { outline-color: #60a5fa66; }
  50% { outline-color: #93c5fd; }
}

@keyframes docs-branch-wait {
  0%,80%,100% { opacity: .3; }
  40% { opacity: 1; }
}

@media(max-width:600px) {
  .branch-demo { padding: 12px; }
  .message { padding: 10px 8px; }
  .message-tools { margin-left: auto; gap: 1px; }
  .message-tools button,.decoration { padding: 4px; }
  .version-paging span { min-width: 28px; }
  .editor-buttons { width: 100%; }
  .editor-tools { padding-bottom: 3px; }
  .editor-buttons kbd,.sample-send kbd { display: none; }
  .sample-input { margin-inline: 8px; }
  .input-footer { gap: 7px; }
  .model-select { min-width: 0; font-size: 8px; }
  .sample-chat { padding: 6px 3px; font-size: 8px; }
  .branch-demo .message-text { font-size: 12px; }
}
</style>
