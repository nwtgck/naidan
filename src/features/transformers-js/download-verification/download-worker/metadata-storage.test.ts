// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { createRuntimeMetadataStorage } from './metadata-storage';

const revision = 'a'.repeat(40);
const url = `https://huggingface.co/org/model/resolve/${revision}/tokenizer_config.json`;
const base = `models/huggingface.co/org/model/resolve/${revision}/`;
const path = `${base}tokenizer_config.json`;
const marker = `${base}.tokenizer_config.json.complete`;

beforeEach(() => {
  vi.stubGlobal('self', { location: { origin: 'http://localhost' } });
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const fs = createMemoryFiles();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  let directory = fs.root;
  for (const name of base.split('/').filter(Boolean)) {
    directory = await directory.getDirectoryHandle(name, { create: true });
  }
  fs.activity.length = 0;
  return { fs, storage: createRuntimeMetadataStorage() };
}

it('publishes metadata only after the real writer closes and returns its exact saved bytes', async () => {
  const { fs, storage } = await fixture();
  const content = '{"tokenizer_class":"FixtureTokenizer"}';
  await storage.write({ url, response: new Response(content) });
  expect(new TextDecoder().decode(fs.files.get(path))).toBe(content);
  expect(fs.files.has(marker)).toBe(true);
  const closed = fs.activity.findIndex(item => item.path === path && item.operation === 'writer-close');
  const marked = fs.activity.findIndex(item => item.path === marker && item.operation === 'create-file');
  expect(closed).toBeGreaterThanOrEqual(0);
  expect(marked).toBeGreaterThan(closed);

  fs.enter({ nextPhase: 'inspect', mutationPolicy: 'read-only' });
  fs.activity.length = 0;
  const stored = await storage.read({ url });
  expect(stored?.byteLength).toBe(new TextEncoder().encode(content).byteLength);
  expect(stored?.response.headers.get('Content-Type')).toBe('application/json');
  expect(await stored?.response.text()).toBe(content);
  expect(fs.activity.every(item => ['stat', 'body-read'].includes(item.operation))).toBe(true);
});

it('rejects partial metadata before touching an existing complete file or marker', async () => {
  const { fs, storage } = await fixture();
  await storage.write({ url, response: new Response('{"before":true}') });
  const before = fs.files.get(path);
  fs.activity.length = 0;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
    status: 206, headers: { 'Content-Range': 'bytes 0-1/100', 'Content-Length': '2' },
  });
  await expect(storage.write({ url, response })).rejects.toThrow('HTTP 206');
  expect(fs.files.get(path)).toBe(before);
  expect(fs.files.has(marker)).toBe(true);
  expect(fs.activity).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
});

it('treats a body without its completion marker as absent without opening its contents', async () => {
  const { fs, storage } = await fixture();
  fs.files.set(path, new TextEncoder().encode('{}'));
  fs.enter({ nextPhase: 'inspect', mutationPolicy: 'read-only' });
  expect(await storage.stat({ url })).toBeUndefined();
  expect(await storage.read({ url })).toBeUndefined();
  expect(fs.activity).toEqual([]);
  expect(fs.files.has(path)).toBe(true);
  expect(fs.files.has(marker)).toBe(false);
});

it('treats an orphan completion marker as absent without repairing it', async () => {
  const { fs, storage } = await fixture();
  fs.files.set(marker, new Uint8Array());
  fs.enter({ nextPhase: 'inspect', mutationPolicy: 'read-only' });
  expect(await storage.stat({ url })).toBeUndefined();
  expect(await storage.read({ url })).toBeUndefined();
  expect(fs.activity).toEqual([]);
  expect(fs.files.has(marker)).toBe(true);
  expect(fs.files.has(path)).toBe(false);
});

it('does not accept an empty metadata body even when a marker exists', async () => {
  const { fs, storage } = await fixture();
  fs.files.set(path, new Uint8Array());
  fs.files.set(marker, new Uint8Array());
  fs.enter({ nextPhase: 'inspect', mutationPolicy: 'read-only' });
  expect(await storage.stat({ url })).toBeUndefined();
  expect(await storage.read({ url })).toBeUndefined();
  expect(fs.activity.every(item => item.operation === 'stat')).toBe(true);
});

it('checks completeness and size without reading metadata bodies', async () => {
  const { fs, storage } = await fixture();
  fs.files.set(path, new TextEncoder().encode('{}'));
  fs.files.set(marker, new Uint8Array());
  fs.enter({ nextPhase: 'inspect', mutationPolicy: 'read-only' });
  expect(await storage.stat({ url })).toBe(2);
  expect(fs.activity).toEqual([{ phase: 'inspect', operation: 'stat', path, bytes: 2 }]);
});

it('preserves permission failures rather than converting them to cache misses', async () => {
  const failure = new DOMException('Fixture permission denied', 'NotAllowedError');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => {
    throw failure;
  } } });
  const storage = createRuntimeMetadataStorage();
  await expect(storage.stat({ url })).rejects.toBe(failure);
  await expect(storage.read({ url })).rejects.toBe(failure);
});

it('leaves an overwritten resource incomplete when its writable close fails', async () => {
  const { fs, storage } = await fixture();
  await storage.write({ url, response: new Response('{"before":true}') });
  const failure = new DOMException('Fixture quota exceeded', 'QuotaExceededError');
  fs.writerCloseErrors.set(path, failure);
  await expect(storage.write({ url, response: new Response('{"after":true}') })).rejects.toBe(failure);
  expect(fs.files.has(marker)).toBe(false);
  expect(await storage.stat({ url })).toBeUndefined();
  expect(await storage.read({ url })).toBeUndefined();
});

it('does not publish a metadata body whose consumed bytes disagree with its response length', async () => {
  const { fs, storage } = await fixture();
  await expect(storage.write({ url, response: new Response('{}', { headers: { 'Content-Length': '3' } }) })).rejects.toThrow(`OPFS byte length mismatch for ${path}: expected 3, received 2`);
  expect(fs.files.has(marker)).toBe(false);
  expect(await storage.stat({ url })).toBeUndefined();
  expect(await storage.read({ url })).toBeUndefined();
});
