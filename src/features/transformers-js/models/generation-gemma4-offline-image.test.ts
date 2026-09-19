// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- Worker adapter regression mocks only the native image-decoding boundary.
import { RawImage } from '@huggingface/transformers';
import { createDownloadedModelWorkerFetch } from '@/features/transformers-js/runtime/offline-worker-fetch';
import { createHostedTransformersModelFetch } from '@/features/transformers-js/runtime/model-fetch';
import { buildGemma4TemplateInput } from './gemma4';

vi.mock('@huggingface/transformers', () => ({
  // Native image decoding is a platform boundary; preserve the actual bytes
  // passed to it through the Production adapter and offline fetch policy.
  RawImage: { read: vi.fn(async () => 'decoded-fixture-image') },
}));

const nativeFetch = globalThis.fetch;
// Fixed synthetic MSI image, not a user attachment or conversation export.
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Gemma 4 offline image preparation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('passes the observed synthetic PNG to image decoding without HTTP authority', async () => {
    const receivedProtocols: string[] = [];
    const localOnlyFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      receivedProtocols.push(url.protocol);
      if (url.protocol !== 'data:') throw new Error('Fixture forbids network access');
      return nativeFetch(input, init);
    };
    const offlineFetch = createDownloadedModelWorkerFetch({
      originalFetch: localOnlyFetch,
      workerLocationUrl: 'https://naidan.example/assets/worker.js',
      environment: 'development', userAgent: 'Chrome', vendor: 'Google Inc.',
    });
    vi.stubGlobal('fetch', createHostedTransformersModelFetch({ runtimeFetch: offlineFetch }));

    const result = await buildGemma4TemplateInput({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe the single synthetic image in one short phrase.' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ] }],
    });

    expect(result.images).toEqual(['decoded-fixture-image']);
    expect(result.templateMessages[0]?.content).toEqual([
      { type: 'text', text: 'Describe the single synthetic image in one short phrase.' },
      { type: 'image' },
    ]);
    expect(receivedProtocols).toEqual(['data:']);
    expect(RawImage.read).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(RawImage.read).mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) throw new Error('Expected image Blob');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(68);
    expect(createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex'))
      .toBe('431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460');
    await expect(offlineFetch('https://huggingface.co/org/model/resolve/main/config.json'))
      .rejects.toThrow('blocked non-runtime network request');
    expect(receivedProtocols).toEqual(['data:']);
  });
});
