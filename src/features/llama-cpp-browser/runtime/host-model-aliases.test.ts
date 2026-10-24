import { describe, expect, it } from 'vitest';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { modelSchema } from '@/features/llama-cpp-browser/types';
import { formatHostModelId, hostModelDirectoryAliases, resolveHostModelLocation } from './host-model-aliases';
import { parsePublicHostModelReference } from './model-destination-types';

function directory({ id, name }: { id: string, name: string }) {
  return { id: toHostModelDirectoryId({ raw: id }), name };
}

describe('registered host folder aliases', () => {
  it('assigns duplicates in registration order while reserving all literal suffix names', () => {
    const directories = ['Models', 'Models', 'Models-2', 'Models-3', 'Models-2', 'Models']
      .map((name, index) => directory({ id: `root-${index}`, name }));
    const before = structuredClone(directories);

    expect([...hostModelDirectoryAliases({ directories }).values()])
      .toEqual(['Models', 'Models-4', 'Models-2', 'Models-3', 'Models-2-2', 'Models-5']);
    expect(directories).toEqual(before);
  });

  it('reserves aliases for roots even when only another root has an available model', () => {
    const directories = [
      directory({ id: 'unavailable', name: 'Models' }),
      directory({ id: 'available', name: 'Models' }),
      directory({ id: 'also-unavailable', name: 'Models-2' }),
    ];
    const modelId = formatHostModelId({ directoryId: 'available', repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories });

    expect(modelId).toBe('host/Models-3/owner/repo:model');
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'available', repository: 'owner/repo' });
  });

  it('reserves every registered ID including its own ID and candidate suffixes', () => {
    const directories = [
      directory({ id: 'Models', name: 'Models' }),
      directory({ id: 'Models-2', name: 'Models' }),
      directory({ id: 'other', name: 'Models-3' }),
    ];
    const aliases = hostModelDirectoryAliases({ directories });

    expect([...aliases.values()]).toEqual(['Models-4', 'Models-5', 'Models-3']);
    for (const { id } of directories) {
      const directoryId = idToRaw({ id });
      const modelId = formatHostModelId({ directoryId, repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories });
      expect(parsePublicHostModelReference({ modelId }).alias).not.toBe(directoryId);
      expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId, repository: 'owner/repo' });
      expect(() => resolveHostModelLocation({ modelId: `host/${encodeURIComponent(directoryId)}/owner/repo:model`, directories })).toThrow('missing-model');
    }
  });

  it('recomputes aliases after rename without remembering an obsolete name', () => {
    const before = [directory({ id: 'root', name: 'Before' })];
    const after = [directory({ id: 'root', name: 'After' })];
    const oldModelId = formatHostModelId({ directoryId: 'root', repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories: before });

    expect(formatHostModelId({ directoryId: 'root', repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories: after })).toBe('host/After/owner/repo:model');
    expect(() => resolveHostModelLocation({ modelId: oldModelId, directories: after })).toThrow('missing-model');
    expect(() => resolveHostModelLocation({ modelId: 'host/root/owner/repo:model.gguf', directories: after })).toThrow('missing-model');
  });

  it('reassigns names after deletion and appends a re-registered root in current order', () => {
    const first = directory({ id: 'first', name: 'Models' });
    const second = directory({ id: 'second', name: 'Models' });
    const initial = [first, second];
    const removed = [second];
    const readded = [second, first];
    const modelId = 'host/Models/owner/repo:model';

    expect(resolveHostModelLocation({ modelId, directories: initial })).toEqual({ directoryId: 'first', repository: 'owner/repo' });
    expect(resolveHostModelLocation({ modelId, directories: removed })).toEqual({ directoryId: 'second', repository: 'owner/repo' });
    expect([...hostModelDirectoryAliases({ directories: readded }).entries()]).toEqual([['second', 'Models'], ['first', 'Models-2']]);
    expect(() => resolveHostModelLocation({ modelId: 'host/first/owner/repo:model', directories: removed })).toThrow('missing-model');
  });

  it('does not retain historical reservations for deleted IDs', () => {
    const directories = [directory({ id: 'current-root', name: 'deleted-root' })];
    expect(resolveHostModelLocation({ modelId: 'host/deleted-root/owner/repo:model', directories }))
      .toEqual({ directoryId: 'current-root', repository: 'owner/repo' });
  });
});

describe('host alias reference boundaries', () => {
  it.each(['a/b', 'a:b', '100% Models', '%2F', '日本語 🚀', ' Models ', 'models', 'Models'])('round-trips the exact folder name %s without changing registration data', folderName => {
    const directories = [directory({ id: 'root', name: folderName })];
    const primaryRelativePath = 'weights:original/100% model 日本語.gguf';
    const modelId = formatHostModelId({ directoryId: 'root', repository: 'owner/repo', primaryRelativePath, directories });

    expect(modelId).toBe(`host/${encodeURIComponent(folderName)}/owner/repo:weights:original/100% model 日本語`);
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'root', repository: 'owner/repo' });
    expect(directories).toEqual([directory({ id: 'root', name: folderName })]);
  });

  it('resolves an alias to the exact opaque directory ID without exposing an internal reference', () => {
    const directoryId = 'same name:%/root';
    const directories = [directory({ id: directoryId, name: 'Models' })];
    const modelId = formatHostModelId({ directoryId, repository: 'owner/repo', primaryRelativePath: 'nested/model.gguf', directories });

    expect(modelId).toBe('host/Models/owner/repo:nested/model');
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId, repository: 'owner/repo' });
    expect(() => resolveHostModelLocation({ modelId: `host/${encodeURIComponent(directoryId)}/owner/repo:nested%2Fmodel.gguf`, directories })).toThrow('missing-model');
  });

  it.each([
    'nested%2fmodel.gguf', '..%2Fmodel.gguf', '%2Fmodel.gguf',
    'weights%5Cmodel.gguf', 'model%00.gguf', '%ZZ.gguf', '%E0%A4%A.gguf',
    'weights:original/100% model 日本語.gguf',
  ])('treats the public selector %s as literal text instead of decoding its filename', selector => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    const modelId = `host/Models/owner/repo:${selector}`;

    expect(parsePublicHostModelReference({ modelId })).toEqual({ alias: 'Models', repository: 'owner/repo', selector });
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'root', repository: 'owner/repo' });
  });

  it('keeps case-distinct aliases and roots separate', () => {
    const directories = [directory({ id: 'Root', name: 'Models' }), directory({ id: 'root', name: 'models' })];
    expect(resolveHostModelLocation({ modelId: 'host/Models/owner/repo:model', directories })).toEqual({ directoryId: 'Root', repository: 'owner/repo' });
    expect(resolveHostModelLocation({ modelId: 'host/models/owner/repo:model', directories })).toEqual({ directoryId: 'root', repository: 'owner/repo' });
  });

  it('uses an explicit empty-name fallback while reserving literal fallback names', () => {
    const directories = [
      directory({ id: 'empty', name: '' }),
      directory({ id: 'literal', name: 'Folder' }),
      directory({ id: 'literal-suffix', name: 'Folder-2' }),
    ];
    expect([...hostModelDirectoryAliases({ directories }).values()]).toEqual(['Folder', 'Folder-3', 'Folder-2']);
    const modelId = formatHostModelId({ directoryId: 'empty', repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories });
    expect(modelId).toBe('host/Folder/owner/repo:model');
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'empty', repository: 'owner/repo' });
  });

  it('allows a duplicate suffix beyond the directory ID codec length limit', () => {
    const folderName = 'a'.repeat(255);
    const directories = [directory({ id: 'first', name: folderName }), directory({ id: 'second', name: folderName })];
    const modelId = formatHostModelId({ directoryId: 'second', repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories });

    expect(modelId).toBe(`host/${folderName}-2/owner/repo:model`);
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'second', repository: 'owner/repo' });
  });

  it.each(['user/model.gguf', 'hf.co/owner/repo:model.gguf', 'remote-model'])('does not route non-host model %s through a linked folder', modelId => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    expect(() => resolveHostModelLocation({ modelId, directories })).toThrow('missing-model');
  });

  it.each([
    'host/unknown/owner/repo:model.gguf',
    'host//owner/repo:model.gguf',
    'host/%zz/owner/repo:model.gguf',
    'host/%4Dodels/owner/repo:model.gguf',
    'host/Models/owner/repo:../model.gguf',
    'host/Models/owner/repo:/model.gguf',
    'host/Models/owner/repo:weights\\model.gguf',
    'host/Models/owner/repo:model.gguf\0',
    'host/Models/owner/repo:model.gguf//extra',
    'host/Models/owner/repo:',
    'host/Models/owner/repo',
    'host/root/owner/repo',
  ])('rejects missing or malformed host modelIds without another storage fallback: %s', modelId => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    expect(() => resolveHostModelLocation({ modelId, directories })).toThrow('missing-model');
  });
});

describe('public host modelIds at the inventory schema boundary', () => {
  it('accepts an encoded Unicode alias longer than 1024 characters', () => {
    const directories = [directory({ id: 'root', name: '日'.repeat(255) })];
    const modelId = formatHostModelId({ directoryId: 'root', repository: 'owner/repo', primaryRelativePath: 'nested/model.gguf', directories });

    expect(modelId.length).toBeGreaterThan(1024);
    expect(modelSchema.safeParse({ modelId, size: 128, importedAt: 1 }).success).toBe(true);
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'root', repository: 'owner/repo' });
  });

  it('passes modelId data without a source-specific length boundary', () => {
    const prefix = `hf.co/owner/repo:${'a'.repeat(250)}/`;
    const model = { size: 128, importedAt: 1 };
    expect(modelSchema.safeParse({ ...model, modelId: `${prefix}${'b'.repeat(512 - prefix.length)}` }).success).toBe(true);
    expect(modelSchema.safeParse({ ...model, modelId: `${prefix}${'b'.repeat(513 - prefix.length)}` }).success).toBe(true);
  });

  it('validates readable Unicode selectors without encoding their file paths', () => {
    const primaryRelativePath = `${'日'.repeat(40)}/${'本'.repeat(40)}.gguf`;
    const directories = [directory({ id: 'root', name: 'Models' })];
    const modelId = formatHostModelId({ directoryId: 'root', repository: 'owner/repo', primaryRelativePath, directories });

    expect(encodeURIComponent(primaryRelativePath).length).toBeGreaterThan(255);
    expect(modelId).toBe(`host/Models/owner/repo:${'日'.repeat(40)}/${'本'.repeat(40)}`);
    expect(modelSchema.safeParse({ modelId, size: 128, importedAt: 1 }).success).toBe(true);
    expect(resolveHostModelLocation({ modelId, directories })).toEqual({ directoryId: 'root', repository: 'owner/repo' });
  });
});
