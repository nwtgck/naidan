// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { downloadImageRecipe } from './catalog-download';
import { listImageRepositories } from './repository-store';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import type { PrivacyFetchStreamResponse } from '@/features/privacy-fetch';
const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: calls.fetch }));
let root: MemoryDirectory;
const revision = 'a'.repeat(40);
const file: ImageRecipeFile = { role: 'diffusion', repository: 'org/model', revision, path: 'weights/model.gguf', directory: 'model', approximateSize: '32 B' };
function gguf(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46554747, true); view.setUint32(4, 3, true); return bytes;
}
function response({ bytes, status, headers }: { bytes: Uint8Array<ArrayBuffer>, status: number, headers: Record<string, string> }): PrivacyFetchStreamResponse {
  return { url: '', status, statusText: '', ok: status === 200, redirected: false, responseType: 'basic', headers: new Headers(headers), policyName: 'huggingface_models',
    body: new ReadableStream({ start(controller) {
      controller.enqueue(bytes); controller.close();
    } }),
  };
}
function metadata({ bytes, path }: { bytes: Uint8Array<ArrayBuffer>, path: string }): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([{ type: 'file', path, size: bytes.length, lfs: { size: bytes.length, oid: createHash('sha256').update(bytes).digest('hex') } }]));
}
function serve({ actual, expected }: { actual: Uint8Array<ArrayBuffer>, expected: Uint8Array<ArrayBuffer> }): void {
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string } }) => request.url.includes('/api/')
    ? response({ bytes: metadata({ bytes: expected, path: file.path }), status: 200, headers: {} })
    : response({ bytes: actual, status: 200, headers: {} }));
}
async function stored(): Promise<MemoryDirectory> {
  let folder = root;
  for (const name of ['models', 'huggingface.co', 'org', 'model', 'resolve', 'main']) folder = await folder.getDirectoryHandle(name);
  return folder;
}
beforeEach(() => {
  root = new MemoryDirectory('root'); calls.fetch.mockReset();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, options: { signal?: AbortSignal }, run: () => Promise<void>) => {
    options.signal?.throwIfAborted(); await run();
  } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it('never fetches on inventory read; explicit download writes original paths and exact bytes', async () => {
  const bytes = gguf(); serve({ actual: bytes, expected: bytes });
  await listImageRepositories({ signal: undefined }); expect(calls.fetch).not.toHaveBeenCalled();
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(calls.fetch.mock.calls[0]![0].request.url).toContain(`/tree/${revision}/weights?`);
  expect(calls.fetch.mock.calls[1]![0].request.url).toBe(`https://huggingface.co/org/model/resolve/${revision}/weights/model.gguf`);
  const inventory = await listImageRepositories({ signal: undefined });
  expect(inventory[0]?.id).toBe('huggingface.co/org/model/resolve/main'); expect(inventory[0]?.files[0]?.path).toBe(file.path);
  expect(new Uint8Array(await inventory[0]!.files[0]!.file.arrayBuffer())).toEqual(bytes);
});
it('verifies an existing file and reuses it without a second payload request', async () => {
  const bytes = gguf(); serve({ actual: bytes, expected: bytes });
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/'))).toHaveLength(1);
});
it('never promotes a truncated payload, even without a Content-Length header', async () => {
  serve({ actual: gguf().subarray(0, 16), expected: gguf() });
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('SHA-256');
  expect(await listImageRepositories({ signal: undefined })).toEqual([]);
  expect((await stored()).children.has('.llama-cpp-import-pending')).toBe(false);
});
it('rejects same-size corruption and leaves no completed-looking weight', async () => {
  const wrong = gguf(); wrong[31] = 10; serve({ actual: wrong, expected: gguf() });
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('SHA-256');
  expect(await listImageRepositories({ signal: undefined })).toEqual([]);
});
it('preserves a conflicting pre-existing file byte for byte', async () => {
  const bytes = gguf(); serve({ actual: bytes, expected: bytes });
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  const folder = await (await stored()).getDirectoryHandle('weights'), saved = await folder.getFileHandle('model.gguf');
  saved.data[31] = 1;
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('preserved without overwrite');
  expect(saved.data[31]).toBe(1); expect(calls.fetch).toHaveBeenCalledTimes(3);
});
it('does not consume or erase another importer pending marker', async () => {
  const bytes = gguf(); serve({ actual: bytes, expected: bytes });
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  const folder = await stored(); const marker = await folder.getFileHandle('.llama-cpp-import-pending', { create: true }); marker.data = new Uint8Array([7]);
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('unfinished');
  expect(marker.data).toEqual(new Uint8Array([7]));
});
it('cancels, rolls back only owned files, and supports an explicit retry', async () => {
  serve({ actual: gguf(), expected: gguf() }); const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'transferring') abort.abort();
  } })).rejects.toThrow();
  expect(await listImageRepositories({ signal: undefined })).toEqual([]);
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(await listImageRepositories({ signal: undefined })).toHaveLength(1);
});
it('rejects malicious revisions and paths before storage or network', async () => {
  for (const invalid of [{ ...file, revision: '../main' }, { ...file, path: '../evil.gguf' }, { ...file, repository: '../model' }]) {
    await expect(downloadImageRecipe({ files: [invalid], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow();
  }
  expect(calls.fetch).not.toHaveBeenCalled(); expect(root.children.size).toBe(0);
});
it('rejects a remote pagination redirect rather than following another origin', async () => {
  calls.fetch.mockResolvedValue(response({ bytes: new TextEncoder().encode('[]'), status: 200, headers: { link: '<https://evil.invalid/files>; rel="next"' } }));
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('pagination');
  expect(calls.fetch).toHaveBeenCalledOnce(); expect(root.children.size).toBe(0);
});
it('reports HTTP errors without leaving a completion marker or accepting an empty file', async () => {
  serve({ actual: gguf(), expected: gguf() });
  calls.fetch.mockResolvedValueOnce(response({ bytes: metadata({ bytes: gguf(), path: file.path }), status: 200, headers: {} }))
    .mockResolvedValueOnce(response({ bytes: new Uint8Array(), status: 403, headers: {} }));
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('HTTP 403');
  expect(await listImageRepositories({ signal: undefined })).toEqual([]);
});
