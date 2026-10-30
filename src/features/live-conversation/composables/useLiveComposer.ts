import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { LiveTurnSettings } from '@/features/live-conversation/logic/controller';
import { liveAudioFileLimit } from '@/features/live-conversation/logic/audio-file';

export type LiveDraftFile = { file: File, url: string };
export type LiveDraft = { text: string, images: LiveDraftFile[], audio: LiveDraftFile | undefined };
export type LivePendingMessage = { id: string, draft: LiveDraft, settings: LiveTurnSettings, status: 'waiting' | 'paused' };
export type LiveDraftFailure = 'images-unavailable' | 'invalid-attachment' | 'queue-full' | 'send-failed';

const emptyDraft = (): LiveDraft => ({ text: '', images: [], audio: undefined });

export const livePendingLimit = 8;

/** Draft editing never holds the inference lane. Queued messages own immutable
 * channel choices and media; only the head is submitted after inference AND
 * automatic playback are idle. A failure pauses the queue rather than retrying. */
export function useLiveComposer({ canProcess, deliver }: {
  canProcess(): boolean,
  deliver({ message }: { message: LivePendingMessage }): Promise<'accepted' | 'rejected'>,
}) {
  const draft = shallowRef<LiveDraft>(emptyDraft());
  const pending = shallowRef<LivePendingMessage[]>([]);
  const failure = ref<LiveDraftFailure>();
  const delivering = ref(false);
  const held = ref(false);
  const urls = new Set<string>();
  let speechDraftReserved = false;
  let epoch = 0;
  let disposed = false;
  const hasDraft = computed(() => !!draft.value.text.trim() || draft.value.images.length > 0 || draft.value.audio !== undefined);
  function releaseFile({ attachment }: { attachment: LiveDraftFile }): void {
    if (urls.delete(attachment.url)) {
      URL.revokeObjectURL(attachment.url);
    }
  }
  function release({ value }: { value: LiveDraft }): void {
    for (const attachment of value.images) {
      releaseFile({ attachment });
    }
    if (value.audio) {
      releaseFile({ attachment: value.audio });
    }
  }
  function wrap({ file }: { file: File }): LiveDraftFile {
    const url = URL.createObjectURL(file);
    urls.add(url);
    return { file, url };
  }
  function attach({ files, imagesAllowed }: { files: readonly File[], imagesAllowed: boolean }): void {
    if (disposed || !files.length) {
      return;
    }
    const images: File[] = [];
    const audio: File[] = [];
    for (const file of files) {
      if (file.type.startsWith('image/') || (!file.type && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name))) {
        images.push(file);
      } else if (file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|webm)$/i.test(file.name)) {
        audio.push(file);
      } else {
        failure.value = 'invalid-attachment';
        return;
      }
    }
    if (images.length && !imagesAllowed) {
      failure.value = 'images-unavailable';
      return;
    }
    if (images.length + draft.value.images.length > 4 || audio.length + (draft.value.audio ? 1 : 0) > 1 || [...images, ...audio].some(file => file.size === 0 || file.size > liveAudioFileLimit)) {
      failure.value = 'invalid-attachment';
      return;
    }
    // Validate the complete drop first: a rejected file must not silently cause
    // the other attachments to be submitted alone.
    const nextImages: LiveDraftFile[] = [];
    let nextAudio: LiveDraftFile | undefined;
    try {
      for (const file of images) {
        nextImages.push(wrap({ file }));
      }
      if (audio[0]) {
        nextAudio = wrap({ file: audio[0] });
      }
      draft.value = { ...draft.value, images: [...draft.value.images, ...nextImages], audio: nextAudio ?? draft.value.audio };
      failure.value = undefined;
    } catch {
      release({ value: { text: '', images: nextImages, audio: nextAudio } });
      failure.value = 'invalid-attachment';
    }
  }
  function remove({ url }: { url: string }): void {
    const image = draft.value.images.find(item => item.url === url);
    if (image) {
      releaseFile({ attachment: image });
      draft.value = { ...draft.value, images: draft.value.images.filter(item => item !== image) };
    } else if (draft.value.audio?.url === url) {
      releaseFile({ attachment: draft.value.audio });
      draft.value = { ...draft.value, audio: undefined };
    }
  }
  function take(): LiveDraft {
    const result = draft.value;
    draft.value = emptyDraft();
    return result;
  }
  function enqueue({ settings }: { settings: LiveTurnSettings }): void {
    if (disposed || !hasDraft.value) {
      return;
    }
    if (pending.value.length + Number(delivering.value) + Number(speechDraftReserved) >= livePendingLimit) {
      failure.value = 'queue-full';
      return;
    }
    pending.value = [...pending.value, { id: crypto.randomUUID(), draft: take(), settings: { ...settings }, status: 'waiting' }];
    failure.value = undefined;
  }
  function reserveSpeechDraft(): boolean {
    if (disposed || speechDraftReserved || pending.value.length + Number(delivering.value) >= livePendingLimit) {
      failure.value = 'queue-full';
      return false;
    }
    // Permission may fail after the user has already queued another message.
    // Reserve room for that recovery instead of losing or unboundedly appending it.
    speechDraftReserved = true;
    return true;
  }
  function releaseSpeechDraft(): void {
    speechDraftReserved = false;
  }
  function cancel({ id }: { id: string }): void {
    const message = pending.value.find(item => item.id === id);
    if (message) {
      pending.value = pending.value.filter(item => item !== message);
      release({ value: message.draft });
    }
  }
  function edit({ id, text }: { id: string, text: string }): void {
    pending.value = pending.value.map(item => item.id === id ? { ...item, draft: { ...item.draft, text } } : item);
  }
  function retry({ id }: { id: string }): void {
    pending.value = pending.value.map(item => item.id === id ? { ...item, status: 'waiting' } : item);
    failure.value = undefined;
  }
  function clear(): void {
    epoch++;
    release({ value: draft.value });
    for (const message of pending.value) {
      release({ value: message.draft });
    }
    draft.value = emptyDraft();
    pending.value = [];
    failure.value = undefined;
  }
  async function drain(): Promise<void> {
    if (disposed || held.value || delivering.value || !canProcess()) {
      return;
    }
    const message = pending.value[0];
    if (!message || message.status !== 'waiting') {
      return;
    }
    if (!message.draft.text.trim() && !message.draft.images.length && !message.draft.audio) {
      pending.value = [{ ...message, status: 'paused' }, ...pending.value.slice(1)];
      return;
    }
    const generation = epoch;
    delivering.value = true;
    pending.value = pending.value.slice(1);
    let outcome: 'accepted' | 'rejected' = 'rejected';
    try {
      outcome = await deliver({ message });
    } catch {
      // Preserve the draft for a manual retry; the native controller reports its
      // own failure too. Never let an unhandled rejection lose queued media.
    } finally {
      if (!disposed && generation === epoch && outcome === 'rejected') {
        pending.value = [{ ...message, status: 'paused' }, ...pending.value];
        failure.value = 'send-failed';
      } else {
        release({ value: message.draft });
      }
      delivering.value = false;
    }
  }
  watch([() => canProcess(), pending, delivering, held], () => {
    void drain();
  }, { flush: 'post' });
  onScopeDispose(() => {
    disposed = true;
    clear();
    // Also release the currently delivering message. Its File is held by the
    // operation independently of its preview URL.
    for (const url of urls) {
      URL.revokeObjectURL(url);
    }
    urls.clear();
  });
  return { draft, pending, failure, delivering, held, hasDraft, attach, remove, take, release, enqueue, reserveSpeechDraft, releaseSpeechDraft, cancel, edit, retry, clear, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
