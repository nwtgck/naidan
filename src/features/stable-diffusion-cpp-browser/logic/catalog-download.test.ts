// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { downloadImageRecipe as acquire, type ImageRecipeDownloadRequest } from './catalog-download';
import { privacyFetchStream } from '@/features/privacy-fetch';
function downloadImageRecipe({ files, signal, onProgress }: ImageRecipeDownloadRequest): Promise<void> {
  return acquire({ files, signal, onProgress, fetch: privacyFetchStream });
}
import { listImageRepositories } from './repository-store';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import type { PrivacyFetchStreamResponse } from '@/features/privacy-fetch';
const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: calls.fetch }));
let root: MemoryDirectory;
const revision = 'a'.repeat(40);
const file: ImageRecipeFile = { role: 'diffusion', repository: 'org/model', revision, path: 'weights/model.gguf', directory: 'model', approximateBytes: 32 };
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
  vi.unstubAllGlobals(); vi.restoreAllMocks();
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
  expect((await listImageRepositories({ signal: undefined })).flatMap(repo => repo.files)).toEqual([]);
  expect((await (await stored()).getDirectoryHandle('weights')).children.has('.model.gguf.pending')).toBe(true);
  expect((await (await stored()).getDirectoryHandle('weights')).children.has('.model.gguf.complete')).toBe(false);
});
it('rejects same-size corruption and leaves no completed-looking weight', async () => {
  const wrong = gguf(); wrong[31] = 10; serve({ actual: wrong, expected: gguf() });
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('SHA-256');
  expect((await listImageRepositories({ signal: undefined })).flatMap(repo => repo.files)).toEqual([]);
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
it('pauses with an unpublished checkpoint and supports an explicit retry', async () => {
  serve({ actual: gguf(), expected: gguf() }); const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'transferring') abort.abort();
  } })).rejects.toThrow();
  expect((await listImageRepositories({ signal: undefined })).flatMap(repo => repo.files)).toEqual([]);
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
  expect((await listImageRepositories({ signal: undefined })).flatMap(repo => repo.files)).toEqual([]);
});

it('publishes a snapshot-bound complete receipt only after verification and clears pending', async () => {
  serve({ actual: gguf(), expected: gguf() });
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  const folder = await (await stored()).getDirectoryHandle('weights');
  expect(folder.children.has('.model.gguf.pending')).toBe(false);
  const receipt = JSON.parse(await (await folder.getFileHandle('.model.gguf.complete')).getFile().then(file => file.text()));
  expect(receipt).toMatchObject({ version: 1, kind: 'naidan-model-file', size: 32, source: { kind: 'hugging-face', revision, path: file.path } });
  expect(receipt.lastModified).toBe((await (await folder.getFileHandle('model.gguf')).getFile()).lastModified);
});
it('does not auto-use a missing, malformed or stale complete receipt, and verifies markerless existing bytes without another payload download', async () => {
  serve({ actual: gguf(), expected: gguf() });
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  const folder = await (await stored()).getDirectoryHandle('weights');
  await folder.removeEntry('.model.gguf.complete');
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toEqual([]);
  const writes = vi.spyOn(await folder.getFileHandle('model.gguf'), 'createWritable');
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(writes).not.toHaveBeenCalled();
  expect(calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/'))).toHaveLength(1);
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toHaveLength(1);
  const receipt = await folder.getFileHandle('.model.gguf.complete');
  receipt.data = new TextEncoder().encode('{}');
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toEqual([]);
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  (await folder.getFileHandle('model.gguf')).modified++;
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toEqual([]);
});
it('resumes only recorded bytes with Range and rehashes the entire prefix plus suffix', async () => {
  // Advance the presentation clock so a small fixture produces a partial update.
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now += 200);
  const bytes = new Uint8Array(600_000); bytes.set(gguf());
  const abort = new AbortController(); let offset: number | undefined;
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string, headers?: [string, string][] } }) => {
    if (request.url.includes('/api/')) return response({ bytes: metadata({ bytes, path: file.path }), status: 200, headers: {} });
    const range = request.headers?.find(([name]) => name === 'Range')?.[1];
    offset = range ? Number(range.slice(6, -1)) : 0;
    return response({ bytes: bytes.slice(offset), status: offset ? 206 : 200,
      headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} });
  });
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'transferring' && progress.fileCompleted > 0) abort.abort();
  } })).rejects.toThrow();
  const folder = await (await stored()).getDirectoryHandle('weights');
  const partial = (await (await folder.getFileHandle('model.gguf')).getFile()).size;
  expect(partial).toBeGreaterThan(0); expect(partial).toBeLessThan(bytes.length);
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(offset).toBe(partial);
  expect((await listImageRepositories({ signal: undefined }))[0]?.files[0]?.file.size).toBe(bytes.length);
  expect(folder.children.has('.model.gguf.complete')).toBe(true);
});
it('restarts an owned partial file when the server ignores Range with a valid full response', async () => {
  // Advance the presentation clock so a small fixture produces a partial update.
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now += 200);
  const bytes = new Uint8Array(600_000); bytes.set(gguf()); serve({ actual: bytes, expected: bytes });
  const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'transferring' && progress.fileCompleted > 0) abort.abort();
  } })).rejects.toThrow();
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  const payloadCalls = calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/'));
  expect(payloadCalls[1]?.[0].request.headers).toEqual([['Range', expect.stringMatching(/^bytes=\d+-$/)]]);
  const saved = (await listImageRepositories({ signal: undefined }))[0]!.files[0]!.file;
  expect(new Uint8Array(await saved.arrayBuffer())).toEqual(bytes);
});
it('rejects an invalid Content-Range without publishing and retains its pending checkpoint', async () => {
  // Advance the presentation clock so a small fixture produces a partial update.
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now += 200);
  const bytes = new Uint8Array(600_000); bytes.set(gguf()); serve({ actual: bytes, expected: bytes });
  const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'transferring' && progress.fileCompleted > 0) abort.abort();
  } })).rejects.toThrow();
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string } }) => request.url.includes('/api/')
    ? response({ bytes: metadata({ bytes, path: file.path }), status: 200, headers: {} })
    : response({ bytes: bytes.slice(1), status: 206, headers: { 'content-range': `bytes 1-${bytes.length - 1}/${bytes.length}` } }));
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('Content-Range');
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toEqual([]);
});
it('reverifies a full pending file locally after a publication interruption, never promoting on size alone', async () => {
  serve({ actual: gguf(), expected: gguf() }); const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'verifying' && progress.fileCompleted === progress.fileTotal) abort.abort();
  } })).rejects.toThrow();
  const count = calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/')).length;
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/'))).toHaveLength(count);
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toHaveLength(1);
});
it('uses one aggregate byte total across all components; verification/reuse does not count as network throughput', async () => {
  const bytes = gguf();
  const second = { ...file, path: 'weights/second.gguf' };
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string } }) => request.url.includes('/api/')
    ? response({ bytes: new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(metadata({ bytes, path: file.path }))).concat(JSON.parse(new TextDecoder().decode(metadata({ bytes, path: second.path })))))), status: 200, headers: {} })
    : response({ bytes, status: 200, headers: {} }));
  const progress = vi.fn();
  await downloadImageRecipe({ files: [file, second], signal: new AbortController().signal, onProgress: progress });
  expect(progress.mock.lastCall?.[0].progress).toMatchObject({ phase: 'complete', completed: 64, total: 64, processed: 64, count: 2 });
  progress.mockClear();
  await downloadImageRecipe({ files: [file, second], signal: new AbortController().signal, onProgress: progress });
  expect(progress.mock.lastCall?.[0].progress).toMatchObject({ phase: 'complete', completed: 64, total: 64, processed: 0 });
});

it('keeps partial image downloads hidden from the existing llama.cpp reader as well', async () => {
  const { readModelFiles } = await import('@/features/llama-cpp-browser/runtime/model-directory');
  serve({ actual: gguf(), expected: gguf() }); const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'verifying') abort.abort();
  } })).rejects.toThrow();
  const folder = await stored();
  expect(await readModelFiles({ folder: folder as unknown as FileSystemDirectoryHandle, prefix: '' })).toEqual([]);
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect((await readModelFiles({ folder: folder as unknown as FileSystemDirectoryHandle, prefix: '' })).map(entry => entry.path)).toEqual([file.path]);
});
it('does not publish when writing the completion receipt fails, and recovers without a second payload', async () => {
  serve({ actual: gguf(), expected: gguf() });
  calls.fetch.mockImplementation(async ({ request }: { request: { url: string } }) => {
    if (request.url.includes('/api/')) return response({ bytes: metadata({ bytes: gguf(), path: file.path }), status: 200, headers: {} });
    const directory = await (await stored()).getDirectoryHandle('weights');
    (await directory.getFileHandle('.model.gguf.complete', { create: true })).failWrite = true;
    return response({ bytes: gguf(), status: 200, headers: {} });
  });
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('Quota');
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toEqual([]);
  const directory = await (await stored()).getDirectoryHandle('weights');
  expect(directory.children.has('.model.gguf.pending')).toBe(true);
  (await directory.getFileHandle('.model.gguf.complete')).failWrite = false;
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toHaveLength(1);
  expect(calls.fetch.mock.calls.filter(([{ request }]) => !request.url.includes('/api/'))).toHaveLength(1);
});
it('preserves foreign pending intent and existing bytes instead of overwriting another source', async () => {
  serve({ actual: gguf(), expected: gguf() }); const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'verifying') abort.abort();
  } })).rejects.toThrow();
  const directory = await (await stored()).getDirectoryHandle('weights');
  const handle = await directory.getFileHandle('model.gguf'), snapshot = handle.data.slice();
  const other = { ...file, revision: 'b'.repeat(40) };
  await expect(downloadImageRecipe({ files: [other], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('Another download owns');
  expect(handle.data).toEqual(snapshot); expect(directory.children.has('.model.gguf.pending')).toBe(true);
});
it('detects corrupted checkpoint bytes on resume and never promotes a full-size corrupt file', async () => {
  serve({ actual: gguf(), expected: gguf() }); const abort = new AbortController();
  await expect(downloadImageRecipe({ files: [file], signal: abort.signal, onProgress({ progress }) {
    if (progress.phase === 'verifying') abort.abort();
  } })).rejects.toThrow();
  const directory = await (await stored()).getDirectoryHandle('weights');
  const handle = await directory.getFileHandle('model.gguf'); handle.data[31] = 99;
  await expect(downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} })).rejects.toThrow('SHA-256');
  expect(directory.children.has('.model.gguf.complete')).toBe(false);
  expect((await listImageRepositories({ signal: undefined }))[0]?.files).toEqual([]);
  await downloadImageRecipe({ files: [file], signal: new AbortController().signal, onProgress() {} });
  expect(handle.data).toEqual(gguf()); expect(directory.children.has('.model.gguf.complete')).toBe(true);
});
