import { describe, expect, it } from 'vitest';
import { modelDownloadUrl } from './download-url';
import { progressSchema } from './types';
const revision = 'a'.repeat(40);
describe('shared pinned download URL', () => {
  it('encodes path segments exactly once and uses a pinned revision', () => {
    const url = modelDownloadUrl({ repository: 'owner/repo', revision, file: { path: 'folder with space/a#b?x=1%2F模型.gguf', size: 128 } });
    expect(url).toBe(`https://huggingface.co/owner/repo/resolve/${revision}/folder%20with%20space/a%23b%3Fx%3D1%252F%E6%A8%A1%E5%9E%8B.gguf`);
    expect(new URL(url).search).toBe(''); expect(new URL(url).hash).toBe('');
  });
  it.each(['../model.gguf','folder/../model.gguf','/model.gguf','folder\\model.gguf','folder//model.gguf','bad\u0000.gguf','model.txt'])('rejects unsafe path %s', path => {
    expect(() => modelDownloadUrl({ repository: 'owner/repo', revision, file: { path, size: 128 } })).toThrow();
  });
  it.each(['main', '../main', 'a'.repeat(39)])('rejects an unpinned revision %s', revision => {
    expect(() => modelDownloadUrl({ repository: 'owner/repo', revision, file: { path: 'model.gguf', size: 128 } })).toThrow();
  });
  it('rejects external hosts instead of using source input as an href', () => {
    expect(() => modelDownloadUrl({ repository: 'https://evil.example/r', revision, file: { path: 'model.gguf', size: 128 } })).toThrow();
  });
  it('keeps active file identity transient and validates its bounds as an index', () => {
    const base = { phase: 'transferring', completed: 0, total: 128, processed: 0 };
    expect(progressSchema.parse(base)).toEqual(base);
    expect(progressSchema.parse({ ...base, currentFileIndex: 2 }).currentFileIndex).toBe(2);
    for (const currentFileIndex of [-1, 0.5, Infinity]) expect(progressSchema.safeParse({ ...base, currentFileIndex }).success).toBe(false);
  });
});
