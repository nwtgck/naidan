import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, expect, it, vi } from 'vitest';
import { toBinaryObjectId } from '@/01-models/ids';
import { createBlobZipSource, createWebZipCompressionCodec, StreamingZipReader } from '@/utils/zip-stream';
import { createImageGenerationArchive } from './export';

beforeEach(() => vi.stubGlobal('Blob', NodeBlob));

it('streams a readable archive containing exact source bytes and Unicode metadata', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], { type: 'image/png' });
  const source = new Blob(['{"title":"雨の夜景","prompt":"映画的"}'], { type: 'application/json' });
  const archive = createImageGenerationArchive({ snapshot: { metadata: [{ path: 'session.json', blob: source }], binaries: [{ id: toBinaryObjectId({ raw: 'image-aa' }), blob: png }] }, exportedAt: 1700000000000 });
  const blob = await new Response(archive.stream).blob(); await archive.completed;
  const reader = new StreamingZipReader({ source: createBlobZipSource({ blob }), compressionCodec: createWebZipCompressionCodec() });
  const files = new Map<string, Uint8Array>();
  try {
    for await (const entry of reader.entries()) files.set(entry.name, new Uint8Array(await new Response(await reader.openEntry({ entry })).arrayBuffer()));
  } finally {
    await reader.close();
  }
  expect([...files.keys()]).toEqual(['README.txt', 'metadata/session.json', 'images/image-aa.png']);
  expect(files.get('images/image-aa.png')).toEqual(new Uint8Array(await png.arrayBuffer()));
  expect(new TextDecoder().decode(files.get('metadata/session.json'))).toBe(await source.text());
  expect(new TextDecoder().decode(files.get('README.txt'))).toContain('Model weights are not included');
});

it('settles the writer when the consumer cancels while image bytes are blocked by backpressure', async () => {
  const archive = createImageGenerationArchive({ snapshot: { metadata: [], binaries: [{ id: toBinaryObjectId({ raw: 'image-aa' }), blob: new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' }) }] }, exportedAt: 1700000000000 });
  const result = expect(archive.completed).rejects.toBeDefined();
  await archive.stream.cancel(new Error('user cancelled')); await result;
});
