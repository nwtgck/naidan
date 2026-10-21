// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { ModelFile } from '@/logic/model-file-system';
import { modelDirectorySchema, resolvedModelSchema } from '@/features/llama-cpp-browser/runtime/resolved-model-schema';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { workerAudioInputSchema, workerGenerateInputSchema, workerPrepareInputSchema } from './types';
import { resolvedModelFixture } from './test-utils/resolved-model.test-support';

afterEach(() => vi.unstubAllGlobals());

function fileEntry({ relativePath, storageKind }: { relativePath: string, storageKind: ModelFile['storageKind'] }): ModelFile {
  const file = new File([new Uint8Array(32)], relativePath.split('/').at(-1)!, { lastModified: 1 });
  switch (storageKind) {
  case 'opfs': case 'host': return { relativePath, file, storageKind, handle: { kind: 'file', name: file.name, getFile: async () => file } as FileSystemFileHandle };
  case 'temp': return { relativePath, file, storageKind, registrationRevision: 1 };
  default: {
    const exhaustive: never = storageKind;
    throw new Error(String(exhaustive));
  }
  }
}

function directory({ files }: { files: ModelFile[] }): ModelDirectory {
  return { files, primaryFile: files[0]!, projectorFile: files.find(entry => entry.relativePath.includes('mmproj')) };
}

describe('captured model transport', () => {
  it('accepts long public host modelIds without the retired exact ID limit or a handle constructor', () => {
    vi.stubGlobal('FileSystemFileHandle', undefined);
    const modelId = `host/${encodeURIComponent('あ'.repeat(80))}/owner/Model-GGUF:${'a'.repeat(180)}/${'b'.repeat(180)}/Q4`;
    expect(modelId.length).toBeGreaterThan(1024);
    const entry = fileEntry({ relativePath: 'nested/Model-Q4.gguf', storageKind: 'host' });
    const resolvedModel: ResolvedModel = { modelId, location: { kind: 'host', directoryId: 'root', repository: 'owner/Model-GGUF' }, directory: directory({ files: [entry] }) };
    const accepted = workerPrepareInputSchema.parse({ modelId, resolvedModel, options: { profile: 'cpu-wasm32' } });
    expect(accepted.modelId).toBe(modelId);
    expect(accepted.resolvedModel.directory.primaryFile.file).toBe(entry.file);
    expect(accepted.resolvedModel.directory.primaryFile).toBe(accepted.resolvedModel.directory.files[0]);
    expect(accepted.resolvedModel.directory.primaryFile.relativePath).toBe('nested/Model-Q4.gguf');
  });

  it.each(['opfs', 'host', 'temp'] as const)('preserves %s provenance and selects the entries from files', storageKind => {
    const files = [fileEntry({ relativePath: 'Model-00001-of-00002.gguf', storageKind }), fileEntry({ relativePath: 'Model-00002-of-00002.gguf', storageKind }), fileEntry({ relativePath: 'mmproj.gguf', storageKind })];
    const accepted = modelDirectorySchema.parse(directory({ files }));
    expect(accepted.primaryFile).toBe(accepted.files[0]);
    expect(accepted.projectorFile).toBe(accepted.files[2]);
    expect(accepted.files.map(entry => entry.file)).toEqual(files.map(entry => entry.file));
  });

  it('rejects an independently supplied File with identical path and metadata', () => {
    const resolved = resolvedModelFixture({ modelId: 'user/Model' });
    const original = resolved.directory.primaryFile;
    const changed = { ...original, file: new File([new Uint8Array(24)], original.file.name, { lastModified: original.file.lastModified }) };
    expect(modelDirectorySchema.safeParse({ ...resolved.directory, primaryFile: changed }).success).toBe(false);
  });

  it('rejects a different handle or storage provenance for a selected file', () => {
    const resolved = resolvedModelFixture({ modelId: 'user/Model' });
    const original = resolved.directory.primaryFile;
    const changed = { ...original, handle: { kind: 'file', getFile: async () => original.file } };
    expect(modelDirectorySchema.safeParse({ ...resolved.directory, primaryFile: changed }).success).toBe(false);
    expect(modelDirectorySchema.safeParse({ ...resolved.directory, primaryFile: { ...original, storageKind: 'host' } }).success).toBe(false);
  });

  it.each([
    ['Model.gguf', 'Model.gguf'],
    ['Model.gguf', 'Model.gguf/nested.gguf'],
    ['../Model.gguf'],
    ['Model-00001-of-00002.gguf'],
    ['Model.gguf', 'Other.gguf'],
    ['Model.gguf', 'mmproj-f16.gguf', 'mmproj-q8.gguf'],
  ])('rejects incomplete or conflicting file trees: %j', (...paths) => {
    const files = paths.map(relativePath => fileEntry({ relativePath, storageKind: 'opfs' }));
    expect(modelDirectorySchema.safeParse(directory({ files })).success).toBe(false);
  });

  it('rejects location/source disagreement and mixed temp registrations', () => {
    const resolved = resolvedModelFixture({ modelId: 'user/Model' });
    expect(resolvedModelSchema.safeParse({ ...resolved, location: { kind: 'host', directoryId: 'root', repository: 'owner/repo' } }).success).toBe(false);
    const files = [fileEntry({ relativePath: 'Model.gguf', storageKind: 'temp' }), fileEntry({ relativePath: 'mmproj.gguf', storageKind: 'temp' })];
    const companion = files[1]!;
    if (companion.storageKind !== 'temp') {
      throw new Error('Expected temporary companion');
    }
    companion.registrationRevision = 2;
    expect(resolvedModelSchema.safeParse({ modelId: 'temp/Model', location: { kind: 'temp', rootPath: 'temp/Model' }, directory: directory({ files }) }).success).toBe(false);
  });

  it('requires resolved files for every operation and rejects a different modelId', () => {
    const modelId = 'user/Model';
    const resolvedModel = resolvedModelFixture({ modelId: 'user/Other' });
    const options = { profile: 'cpu-wasm32' };
    const prepare = { modelId, options };
    const generate = { ...prepare, messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
    const audio = { ...defaultAudioParameters(), ...prepare, text: 'Hello' };
    expect(workerPrepareInputSchema.safeParse(prepare).success).toBe(false);
    expect(workerGenerateInputSchema.safeParse(generate).success).toBe(false);
    expect(workerAudioInputSchema.safeParse(audio).success).toBe(false);
    expect(workerPrepareInputSchema.safeParse({ ...prepare, resolvedModel }).success).toBe(false);
    expect(workerGenerateInputSchema.safeParse({ ...generate, resolvedModel }).success).toBe(false);
    expect(workerAudioInputSchema.safeParse({ ...audio, resolvedModel }).success).toBe(false);
  });
});
