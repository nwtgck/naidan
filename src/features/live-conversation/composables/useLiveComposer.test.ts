import { effectScope, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { useLiveComposer, livePendingLimit, type LivePendingMessage } from './useLiveComposer';

function composerFixture() {
  const ready = ref(false);
  const deliver = vi.fn<({ message }: { message: LivePendingMessage }) => Promise<'accepted' | 'rejected'>>(async () => 'accepted');
  let id = 0;
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:draft-${++id}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const scope = effectScope();
  const composer = scope.run(() => useLiveComposer({ canProcess: () => ready.value, deliver }))!;
  function text({ value }: { value: string }): void {
    composer.draft.value = { ...composer.draft.value, text: value };
  }
  return {
    composer,
    ready,
    deliver,
    create,
    revoke,
    text,
    [Symbol.dispose]() {
      scope.stop();
      create.mockRestore();
      revoke.mockRestore();
    },
  };
}

const settings = { output: 'mixed' as const, transcription: 'on' as const };

describe('independent editable drafts and ordered live sends', () => {
  it('stages text and files while busy and freezes channel settings at submit', async () => {
    using f = composerFixture();
    f.text({ value: 'first' });
    f.composer.attach({ files: [new File(['x'], 'x.png', { type: 'image/png' })], imagesAllowed: true });
    f.composer.enqueue({ settings });
    f.text({ value: 'second draft' });
    expect(f.composer.pending.value[0]?.draft.text).toBe('first');
    expect(f.composer.draft.value.text).toBe('second draft');
    await flushPromises();
    expect(f.deliver).not.toHaveBeenCalled();
    f.ready.value = true;
    await flushPromises();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.deliver.mock.calls[0]?.[0].message.settings).toEqual(settings);
    expect(f.composer.draft.value.text).toBe('second draft');
    expect(f.revoke).toHaveBeenCalledWith('blob:draft-1');
  });

  it('waits for playback readiness as well as delivery completion before sending the next message', async () => {
    using f = composerFixture();
    const gate = Promise.withResolvers<'accepted' | 'rejected'>();
    f.deliver.mockImplementationOnce(async () => {
      f.ready.value = false;
      return gate.promise;
    });
    f.text({ value: 'one' });
    f.composer.enqueue({ settings });
    f.text({ value: 'two' });
    f.composer.enqueue({ settings });
    f.ready.value = true;
    await flushPromises();
    gate.resolve('accepted');
    await flushPromises();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.composer.pending.value).toHaveLength(1);
    f.ready.value = true;
    await flushPromises();
    expect(f.deliver.mock.calls.map(([args]) => args.message.draft.text)).toEqual(['one', 'two']);
  });

  it('allows editing and cancellation without touching the current draft', async () => {
    using f = composerFixture();
    f.text({ value: 'one' });
    f.composer.enqueue({ settings });
    f.text({ value: 'two' });
    f.composer.enqueue({ settings });
    f.text({ value: 'not submitted' });
    f.composer.edit({ id: f.composer.pending.value[0]!.id, text: 'corrected' });
    f.composer.cancel({ id: f.composer.pending.value[1]!.id });
    f.ready.value = true;
    await flushPromises();
    expect(f.deliver.mock.calls[0]?.[0].message.draft.text).toBe('corrected');
    expect(f.composer.draft.value.text).toBe('not submitted');
  });

  it('pauses a failed head and never silently sends later messages first', async () => {
    using f = composerFixture();
    f.deliver.mockRejectedValueOnce(new Error('decoder'));
    f.text({ value: 'one' });
    f.composer.enqueue({ settings });
    f.text({ value: 'two' });
    f.composer.enqueue({ settings });
    f.ready.value = true;
    await flushPromises();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.composer.pending.value[0]?.status).toBe('paused');
    f.composer.retry({ id: f.composer.pending.value[0]!.id });
    await flushPromises();
    expect(f.deliver.mock.calls.map(([args]) => args.message.draft.text)).toEqual(['one', 'one', 'two']);
  });

  it('does not restore an in-flight rejected message after clearing the conversation', async () => {
    using f = composerFixture();
    const gate = Promise.withResolvers<'accepted' | 'rejected'>();
    f.deliver.mockReturnValueOnce(gate.promise);
    f.composer.attach({ files: [new File(['x'], 'voice.wav', { type: 'audio/wav' })], imagesAllowed: true });
    f.composer.enqueue({ settings });
    f.ready.value = true;
    await flushPromises();
    f.composer.clear();
    gate.resolve('rejected');
    await flushPromises();
    expect(f.composer.pending.value).toEqual([]);
    expect(f.composer.failure.value).toBeUndefined();
    expect(f.revoke).toHaveBeenCalledWith('blob:draft-1');
  });

  it('keeps the unsent draft when the queue is full', () => {
    using f = composerFixture();
    for (let i = 0; i < livePendingLimit; i++) {
      f.text({ value: `queued ${i}` });
      f.composer.enqueue({ settings });
    }
    f.text({ value: 'keep me' });
    f.composer.enqueue({ settings });
    expect(f.composer.pending.value).toHaveLength(livePendingLimit);
    expect(f.composer.draft.value.text).toBe('keep me');
    expect(f.composer.failure.value).toBe('queue-full');
  });

  it('validates a whole drop atomically and rejects unsupported images', () => {
    using f = composerFixture();
    const image = new File(['x'], 'x.png', { type: 'image/png' });
    const invalid = new File(['x'], 'no.txt', { type: 'text/plain' });
    f.composer.attach({ files: [image, invalid], imagesAllowed: true });
    expect(f.create).not.toHaveBeenCalled();
    f.composer.attach({ files: [image], imagesAllowed: false });
    expect(f.composer.failure.value).toBe('images-unavailable');
    f.composer.attach({ files: [image], imagesAllowed: true });
    expect(f.composer.draft.value.images).toHaveLength(1);
    f.composer.remove({ url: f.composer.draft.value.images[0]!.url });
    expect(f.revoke).toHaveBeenCalledOnce();
  });

  it('does not drain while a confirmation or microphone handoff holds the queue', async () => {
    using f = composerFixture();
    f.composer.held.value = true;
    f.text({ value: 'one' });
    f.composer.enqueue({ settings });
    f.ready.value = true;
    await flushPromises();
    expect(f.deliver).not.toHaveBeenCalled();
    f.composer.held.value = false;
    await flushPromises();
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it('reserves recovery space while microphone permission is pending', () => {
    using f = composerFixture();
    expect(f.composer.reserveSpeechDraft()).toBe(true);
    for (let i = 0; i < livePendingLimit - 1; i++) {
      f.text({ value: `queued ${i}` });
      f.composer.enqueue({ settings });
    }
    f.text({ value: 'keep the last draft' });
    f.composer.enqueue({ settings });
    expect(f.composer.pending.value).toHaveLength(livePendingLimit - 1);
    expect(f.composer.failure.value).toBe('queue-full');
    f.composer.releaseSpeechDraft();
    f.composer.enqueue({ settings });
    expect(f.composer.pending.value).toHaveLength(livePendingLimit);
    expect(f.composer.reserveSpeechDraft()).toBe(false);
  });

  it('counts an in-flight message so a failed delivery cannot overflow the retry queue', async () => {
    using f = composerFixture();
    const gate = Promise.withResolvers<'accepted' | 'rejected'>();
    f.deliver.mockReturnValueOnce(gate.promise);
    f.text({ value: 'in flight' });
    f.composer.enqueue({ settings });
    f.ready.value = true;
    await flushPromises();
    for (let i = 0; i < livePendingLimit; i++) {
      f.text({ value: `next ${i}` });
      f.composer.enqueue({ settings });
    }
    gate.resolve('rejected');
    await flushPromises();
    expect(f.composer.pending.value).toHaveLength(livePendingLimit);
    expect(f.composer.pending.value[0]?.draft.text).toBe('in flight');
    expect(f.composer.draft.value.text).toBe(`next ${livePendingLimit - 1}`);
  });
});
