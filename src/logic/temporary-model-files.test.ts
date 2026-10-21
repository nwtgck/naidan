// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createTemporaryModelFiles } from './temporary-model-files';
import { temporaryFilePathSchema } from '@/01-models/temporary-model-files';

function directory({ name }: { name: string }) {
  return { name, files: [{ path: 'owner/repository/weights/model.safetensors', file: new File(['weights'], 'model.safetensors') }, { path: 'config.json', file: new File(['{}'], 'config.json') }] };
}

it('retains a whole directory as immutable File references without reading or copying bytes', () => {
  const registry = createTemporaryModelFiles();
  const input = directory({ name: 'models' });
  const file = input.files[0]!.file;
  const read = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('No buffering'));
  const stream = vi.spyOn(file, 'stream').mockImplementation(() => {
    throw new Error('No copying');
  });
  const root = registry.register({ directory: input, signal: undefined });
  expect(root.id).toBe('temp/models');
  expect(root.files[0]!.file).toBe(file);
  expect(root.files.map(entry => entry.path)).toEqual(input.files.map(entry => entry.path));
  input.files.length = 0;
  expect(root.files).toHaveLength(2);
  expect(Object.isFrozen(root.files)).toBe(true);
  expect(Object.isFrozen(root.files[0])).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
});

it('shares name reservations and permits same-name replacement after explicit root removal', () => {
  const registry = createTemporaryModelFiles();
  const first = registry.register({ directory: directory({ name: 'models' }), signal: undefined });
  registry.register({ directory: directory({ name: 'models-2' }), signal: undefined });
  expect(registry.register({ directory: directory({ name: 'models' }), signal: undefined }).id).toBe('temp/models-3');
  registry.remove({ rootId: first.id });
  const next = registry.register({ directory: directory({ name: 'models' }), signal: undefined });
  expect(next.id).toBe(first.id);
  expect(next.revision).not.toBe(first.revision);
  expect(next.files[0]!.file).not.toBe(first.files[0]!.file);
});

it('bounds suffixed names in UTF-8 and normalizes the same colon separator as saved imports', () => {
  const registry = createTemporaryModelFiles();
  const input = directory({ name: '界'.repeat(85) });
  registry.register({ directory: input, signal: undefined });
  const next = registry.register({ directory: input, signal: undefined });
  expect(new TextEncoder().encode(next.name).length).toBeLessThanOrEqual(255);
  expect(next.name.endsWith('-2')).toBe(true);
  expect(registry.register({ directory: directory({ name: 'a:b' }), signal: undefined }).name).toBe('a_b');
});

it.each(['../model.gguf', '/model.gguf', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a/\0b', 'a/\x7fb', '.git/config', 'a/'.repeat(64) + 'file'])('rejects unsafe/reserved path %s before publishing or reserving a name', path => {
  const registry = createTemporaryModelFiles();
  const listener = vi.fn();
  using _subscription = { [Symbol.dispose]: registry.subscribe({ listener }) };
  expect(() => registry.register({ directory: { name: 'root', files: [{ path, file: new File(['x'], 'model.gguf') }] }, signal: undefined })).toThrow();
  expect(registry.list()).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
  expect(registry.register({ directory: directory({ name: 'root' }), signal: undefined }).id).toBe('temp/root');
});

it.each([{ paths: ['x', 'x'] }, { paths: ['x', 'x/y'] }])('rejects duplicate and file-directory collisions: $paths', ({ paths }) => {
  const registry = createTemporaryModelFiles();
  expect(() => registry.register({ directory: { name: 'root', files: paths.map(path => ({ path, file: new File(['x'], 'x') })) }, signal: undefined })).toThrow();
  expect(registry.list()).toEqual([]);
});

it('treats encoded-looking path segments literally and validates the same path used by RPC', () => {
  const registry = createTemporaryModelFiles();
  const paths = ['..%2Fmodel.gguf', '%ZZ.safetensors', '日本語/model:1.sft'];
  const root = registry.register({ directory: { name: 'root', files: paths.map(path => ({ path, file: new File(['x'], path.split('/').at(-1)!) })) }, signal: undefined });
  for (const path of paths) {
    expect(temporaryFilePathSchema.parse(`${root.id}/${path}`)).toBe(`${root.id}/${path}`);
  }
});

it('honors cancellation and isolates observers without retaining disposed listeners', () => {
  const registry = createTemporaryModelFiles();
  const listener = vi.fn();
  using _badListener = {
    [Symbol.dispose]: registry.subscribe({
      listener: () => {
        throw new Error('UI gone');
      },
    }),
  };
  const stop = registry.subscribe({ listener });
  const controller = new AbortController();
  controller.abort();
  expect(() => registry.register({ directory: directory({ name: 'root' }), signal: controller.signal })).toThrow();
  expect(listener).not.toHaveBeenCalled();
  const root = registry.register({ directory: directory({ name: 'root' }), signal: undefined });
  expect(listener).toHaveBeenCalledWith({ rootId: root.id });
  registry.remove({ rootId: root.id });
  registry.remove({ rootId: root.id });
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  registry.register({ directory: directory({ name: 'root' }), signal: undefined });
  expect(listener).toHaveBeenCalledTimes(2);
});

it('retains local download receipts as opaque files without applying storage publication semantics', () => {
  const registry = createTemporaryModelFiles();
  const paths = ['owner/repo/model.gguf', 'owner/repo/.model.gguf.complete', 'owner/repo/.model.gguf.pending', 'owner/repo/.llama-cpp-import-pending'];
  const entries = paths.map(path => ({ path, file: new File(['opaque user bytes'], path.split('/').at(-1)!) }));
  const root = registry.register({ directory: { name: 'downloads', files: entries }, signal: undefined });
  expect(root.files).toEqual(entries);
  for (const [index, entry] of root.files.entries()) {
    expect(entry.file).toBe(entries[index]!.file);
  }
});
