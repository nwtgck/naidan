<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ArrowUpIcon, MicIcon, PlusIcon, SquareIcon, ImageIcon, AudioLinesIcon, XIcon, CornerDownLeftIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LiveDraft } from '@/features/live-conversation/composables/useLiveComposer';

const props = defineProps<{
  draft: LiveDraft,
  textEnabled: boolean,
  imagesAllowed: boolean,
  canSubmit: boolean,
  canTalk: boolean,
  recording: boolean,
  busy: boolean,
}>();
const emit = defineEmits<{
  text: [text: string], attach: [files: File[]], remove: [url: string], send: [], talk: [], finish: [], replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement],
}>();
const id = useId();
const imagePicker = ref<HTMLInputElement>();
const audioPicker = ref<HTMLInputElement>();
const audio = ref<HTMLAudioElement>();
const menu = ref<HTMLDetailsElement>();
const talkLabel = computed(() => props.recording ? lazyStrings.liveConversation__stop_and_send() : props.busy ? lazyStrings.liveConversation__interrupt_and_talk() : lazyStrings.liveConversation__talk());
const sendLabel = computed(() => props.busy ? lazyStrings.liveConversation__send_after_response() : lazyStrings.liveConversation__send());

function choose({ kind }: { kind: 'image' | 'audio' }): void {
  if (menu.value) {
    menu.value.open = false;
  }
  switch (kind) {
  case 'image': imagePicker.value?.click();
    break;
  case 'audio': audioPicker.value?.click();
    break;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
}

function selected({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) {
    emit('attach', Array.from(event.target.files ?? []));
    event.target.value = '';
  }
}

function paste({ event }: { event: ClipboardEvent }): void {
  const files: File[] = [];
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }
  if (files.length) {
    // Keep an accompanying text/plain paste native, like ChatInput. A screenshot
    // without text becomes an attachment rather than a pasted filename.
    if (!event.clipboardData?.getData('text/plain')) {
      event.preventDefault();
    }
    emit('attach', files);
  }
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (props.canSubmit) {
      emit('send');
    }
  }
}

function input({ event }: { event: Event }): void {
  if (event.target instanceof HTMLTextAreaElement) {
    emit('text', event.target.value);
  }
}

function replay({ event, action }: { event: Event, action: 'start' | 'end' }): void {
  if (!(event.target instanceof HTMLAudioElement)) {
    return;
  }
  switch (action) {
  case 'start': emit('replayStart', event.target);
    break;
  case 'end': emit('replayEnd', event.target);
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
}

function pauseAudio(): void {
  audio.value?.pause();
}

defineExpose({ pauseAudio, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- A dedicated composer: ChatInput and existing Chat behavior stay unchanged. -->
  <form @paste="paste({ event: $event })" @submit.prevent="emit('send')" tw-class="rounded-2xl border border-gray-200 bg-white shadow-sm transition-colors focus-within:border-blue-400/70 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-800 dark:focus-within:border-blue-500/60" data-testid="live-composer">
    <div v-if="draft.images.length" tw-class="flex flex-wrap gap-3 px-4 pt-4" data-testid="live-draft-images">
      <div v-for="attachment in draft.images" :key="attachment.url" tw-class="relative">
        <img :src="attachment.url" :alt="attachment.file.name" tw-class="h-20 w-20 rounded-lg border border-gray-200 object-contain dark:border-gray-700" />
        <button type="button" @click="emit('remove', attachment.url)" :aria-label="lazyStrings.liveConversation__remove()" :title="lazyStrings.liveConversation__remove()" tw-class="absolute -right-2 -top-2 rounded-full border border-gray-200 bg-white p-1 text-gray-500 hover:text-red-500 dark:border-gray-600 dark:bg-gray-800"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      </div>
    </div>
    <div v-if="draft.audio" tw-class="mx-4 mt-4 space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40" data-testid="live-draft-audio">
      <div tw-class="flex min-w-0 items-center gap-2 text-xs"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500" /><span tw-class="min-w-0 flex-1 truncate">{{ draft.audio.file.name }}</span><button type="button" @click="emit('remove', draft.audio.url)" :aria-label="lazyStrings.liveConversation__remove()" tw-class="rounded p-1 hover:text-red-500"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button></div>
      <audio ref="audio" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :src="draft.audio.url" controls preload="none" :aria-label="lazyStrings.liveConversation__audio_file()" tw-class="h-9 w-full" />
    </div>
    <label :for="`${id}-text`" tw-class="sr-only">{{ lazyStrings.liveConversation__input_text() }}</label>
    <textarea :id="`${id}-text`" :value="draft.text" :disabled="!textEnabled" :placeholder="lazyStrings.liveConversation__message_placeholder()" maxlength="32768" rows="3" @input="input({ event: $event })" @keydown="keydown({ event: $event })" tw-class="block max-h-64 min-h-24 w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 pb-2 pt-4 text-sm leading-6 outline-none placeholder:text-gray-400 disabled:opacity-40" data-testid="live-text" />
    <div tw-class="flex flex-wrap items-center gap-2 px-3 pb-3">
      <details ref="menu" tw-class="relative" data-testid="live-attachment-menu">
        <summary :aria-label="lazyStrings.liveConversation__add_attachment()" :title="lazyStrings.liveConversation__add_attachment()" tw-class="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-700 [&::-webkit-details-marker]:hidden"><PlusIcon aria-hidden="true" tw-class="h-5 w-5" /></summary>
        <div tw-class="absolute bottom-12 left-0 z-20 w-56 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          <button type="button" :disabled="!imagesAllowed" @click="choose({ kind: 'image' })" tw-class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-700"><ImageIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__attach_images() }}</button>
          <button type="button" @click="choose({ kind: 'audio' })" tw-class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__audio_file() }}</button>
        </div>
      </details>
      <input ref="imagePicker" type="file" multiple accept="image/*" :disabled="!imagesAllowed" @change="selected({ event: $event })" :aria-label="lazyStrings.liveConversation__attach_images()" tw-class="sr-only" data-testid="live-images" />
      <input ref="audioPicker" type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.webm" @change="selected({ event: $event })" :aria-label="lazyStrings.liveConversation__audio_file()" tw-class="sr-only" data-testid="live-audio-file" />
      <span tw-class="mr-auto hidden items-center gap-1 text-[11px] text-gray-400 sm:flex"><CornerDownLeftIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.liveConversation__enter_to_send() }}</span>
      <button v-if="recording" type="button" @click="emit('finish')" :aria-label="talkLabel" :title="talkLabel" tw-class="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 sm:ml-0" data-testid="live-finish"><SquareIcon aria-hidden="true" tw-class="h-4 w-4 fill-current" /></button>
      <button v-else type="button" :disabled="!canTalk || draft.audio !== undefined" @click="emit('talk')" :aria-label="talkLabel" :title="draft.audio ? lazyStrings.liveConversation__remove_audio_to_talk() : talkLabel" tw-class="ml-auto flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 sm:ml-0 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700" data-testid="live-record"><MicIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
      <button type="submit" :disabled="!canSubmit" :aria-label="sendLabel" :title="sendLabel" tw-class="flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40" data-testid="live-send"><ArrowUpIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
    </div>
  </form>
</template>
