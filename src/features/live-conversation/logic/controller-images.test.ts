import { describe, expect, it } from 'vitest';
import { createLiveControllerFixture } from './controller.test-support';
import { liveImageMemoryLimit } from './controller';

const open = { modelId: 'LiquidAI/LFM3-Omni-2B', instructions: '', folder: undefined };
const settings = { output: 'text' as const, transcription: 'off' as const };

function image({ name }: { name: string }) {
  return { name, blob: new Blob(['original image bytes'], { type: 'image/png' }) };
}

describe('ephemeral conversation images', () => {
  it('owns the original Blob after submission without requiring audio retention', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const first = image({ name: 'photo.png' });
    await f.controller.send({ text: 'describe', images: [first], settings });
    const stored = f.controller.getState().entries[0]!.images[0]!;
    expect(stored.blob).toBe(first.blob);
    expect(stored.name).toBe(first.name);
    expect(stored.createdAt).toBeGreaterThan(0);
    f.controller.retainAudio({ value: 'off' });
    expect(f.controller.getState().entries[0]!.images[0]).toBe(stored);
    await f.controller.close();
    expect(f.controller.getState().entries[0]!.images[0]).toBe(stored);
  });

  it('keeps distinct identities for repeated filenames and does not mutate the caller array', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const images = [image({ name: 'same.png' }), image({ name: 'same.png' })];
    await f.controller.send({ text: 'compare', images, settings });
    images.splice(0);
    const stored = f.controller.getState().entries[0]!.images;
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map(item => item.id)).size).toBe(2);
    expect(stored.map(item => item.name)).toEqual(['same.png', 'same.png']);
  });

  it('retains images for a discarded turn, but clears them for a new conversation without reloading', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const first = image({ name: 'question.png' });
    await f.controller.send({ text: 'question', images: [first], settings });
    await f.controller.interrupt();
    expect(f.controller.getState().entries[0]).toMatchObject({ status: 'discarded', images: [{ blob: first.blob }] });
    await f.controller.reset();
    expect(f.controller.getState().entries).toEqual([]);
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    await f.controller.send({ text: 'new conversation', images: [first], settings });
    expect(f.controller.getState().entries).toHaveLength(1);
  });

  it('does not clear accepted images when a native reset fails', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const first = image({ name: 'keep.png' });
    await f.controller.send({ text: 'keep', images: [first], settings });
    f.request.mockRejectedValueOnce(new Error('reset failed'));
    await f.controller.reset();
    expect(f.controller.getState().entries[0]!.images[0]!.blob).toBe(first.blob);
  });

  it('rejects budget overflow before native begin and leaves the preceding conversation intact', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    // Size metadata models a large file without allocating 128 MiB in the suite.
    const large = image({ name: 'large.png' });
    Object.defineProperty(large.blob, 'size', { value: 16 * 1024 * 1024 });
    for (let i = 0; i < liveImageMemoryLimit / large.blob.size; i++) {
      await f.controller.send({ text: `image ${i}`, images: [large], settings });
    }
    const before = f.controller.getState().entries;
    f.request.mockClear();
    await f.controller.send({ text: 'overflow', images: [image({ name: 'extra.png' })], settings });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.controller.getState().entries).toEqual(before);
    expect(f.controller.getState().failure).toContain('128 MiB');
    await f.controller.reset();
    await f.controller.send({ text: 'after clear', images: [large], settings });
    expect(f.controller.getState().entries).toHaveLength(1);
  });

  it('does not resurrect image history when begin completes after close', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const gate = Promise.withResolvers<void>();
    const begun = Promise.withResolvers<void>();
    f.request.mockImplementationOnce(async () => {
      begun.resolve();
      await gate.promise;
      return { type: 'accepted' };
    });
    const sending = f.controller.send({ text: 'late', images: [image({ name: 'late.png' })], settings });
    await begun.promise;
    const closing = f.controller.close();
    gate.resolve();
    await sending;
    await closing;
    expect(f.controller.getState().entries).toEqual([]);
    expect(f.controller.getState().phase).toBe('idle');
  });

  it('releases conversation references on dispose even when the model was already released', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.send({ text: 'inspect', images: [image({ name: 'inspect.png' })], settings });
    await f.controller.close();
    expect(f.controller.getState().entries).toHaveLength(1);
    await f.controller.dispose();
    expect(f.controller.getState().entries).toEqual([]);
  });
});
