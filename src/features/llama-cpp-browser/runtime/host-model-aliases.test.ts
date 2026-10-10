import { describe, expect, it } from 'vitest';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { modelSchema } from '@/features/llama-cpp-browser/types';
import { hostModelDirectoryAliases, hostModelPublicName, resolveHostModelName } from './host-model-aliases';
import { hostModelReference } from './model-destination-types';

function directory({ id, name }: { id: string, name: string }) {
  return { id: toHostModelDirectoryId({ raw: id }), name };
}

function reference({ directoryId, modelPath }: { directoryId: string, modelPath: string | undefined }) {
  return hostModelReference({ directoryId, repository: 'owner/repo', modelPath });
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
    const canonical = reference({ directoryId: 'available', modelPath: 'model.gguf' });
    const name = hostModelPublicName({ name: canonical, directories });

    expect(name).toBe('host/Models-3/owner/repo:model.gguf');
    expect(resolveHostModelName({ name, directories })).toBe(canonical);
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
      const canonical = reference({ directoryId: idToRaw({ id }), modelPath: 'model.gguf' });
      const name = hostModelPublicName({ name: canonical, directories });
      expect(name).not.toBe(canonical);
      expect(resolveHostModelName({ name, directories })).toBe(canonical);
      expect(resolveHostModelName({ name: canonical, directories })).toBe(canonical);
    }
  });

  it('recomputes aliases after rename without remembering an obsolete name', () => {
    const canonical = reference({ directoryId: 'root', modelPath: 'model.gguf' });
    const before = [directory({ id: 'root', name: 'Before' })];
    const after = [directory({ id: 'root', name: 'After' })];
    const oldName = hostModelPublicName({ name: canonical, directories: before });

    expect(hostModelPublicName({ name: canonical, directories: after })).toBe('host/After/owner/repo:model.gguf');
    expect(() => resolveHostModelName({ name: oldName, directories: after })).toThrow('missing-model');
    expect(resolveHostModelName({ name: canonical, directories: after })).toBe(canonical);
  });

  it('reassigns names after deletion and appends a re-registered root in current order', () => {
    const first = directory({ id: 'first', name: 'Models' });
    const second = directory({ id: 'second', name: 'Models' });
    const initial = [first, second];
    const removed = [second];
    const readded = [second, first];
    const name = 'host/Models/owner/repo:model.gguf';

    expect(resolveHostModelName({ name, directories: initial })).toBe(reference({ directoryId: 'first', modelPath: 'model.gguf' }));
    expect(resolveHostModelName({ name, directories: removed })).toBe(reference({ directoryId: 'second', modelPath: 'model.gguf' }));
    expect([...hostModelDirectoryAliases({ directories: readded }).entries()]).toEqual([['second', 'Models'], ['first', 'Models-2']]);
    expect(() => resolveHostModelName({ name: reference({ directoryId: 'first', modelPath: 'model.gguf' }), directories: removed })).toThrow('missing-model');
  });

  it('does not retain historical reservations for deleted IDs', () => {
    const directories = [directory({ id: 'current-root', name: 'deleted-root' })];
    expect(resolveHostModelName({ name: 'host/deleted-root/owner/repo:model.gguf', directories }))
      .toBe('host/current-root/owner/repo:model.gguf');
  });
});

describe('host alias reference boundaries', () => {
  it.each(['a/b', 'a:b', '100% Models', '%2F', '日本語 🚀', ' Models ', 'models', 'Models'])('round-trips the exact folder name %s without changing storage or path encoding', folderName => {
    const directories = [directory({ id: 'root', name: folderName })];
    const modelPath = 'weights:original/100% model 日本語.gguf';
    const canonical = reference({ directoryId: 'root', modelPath });
    const name = hostModelPublicName({ name: canonical, directories });

    expect(name).toBe(`host/${encodeURIComponent(folderName)}/owner/repo:${encodeURIComponent(modelPath)}`);
    expect(resolveHostModelName({ name, directories })).toBe(canonical);
    expect(directories).toEqual([directory({ id: 'root', name: folderName })]);
  });

  it('resolves to the exact encoded opaque ID without interpreting it as an alias', () => {
    const directories = [directory({ id: 'same name:%/root', name: 'Models' })];
    const canonical = reference({ directoryId: 'same name:%/root', modelPath: 'nested/model.gguf' });
    const name = hostModelPublicName({ name: canonical, directories });
    expect(name).toBe('host/Models/owner/repo:nested%2Fmodel.gguf');
    expect(resolveHostModelName({ name, directories })).toBe(canonical);
    expect(resolveHostModelName({ name: canonical, directories })).toBe(canonical);
  });

  it('keeps case-distinct aliases and roots separate', () => {
    const directories = [directory({ id: 'Root', name: 'Models' }), directory({ id: 'root', name: 'models' })];
    expect(resolveHostModelName({ name: 'host/Models/owner/repo:model.gguf', directories })).toBe('host/Root/owner/repo:model.gguf');
    expect(resolveHostModelName({ name: 'host/models/owner/repo:model.gguf', directories })).toBe('host/root/owner/repo:model.gguf');
  });

  it('uses an explicit empty-name fallback while reserving literal fallback names', () => {
    const directories = [
      directory({ id: 'empty', name: '' }),
      directory({ id: 'literal', name: 'Folder' }),
      directory({ id: 'literal-suffix', name: 'Folder-2' }),
    ];
    expect([...hostModelDirectoryAliases({ directories }).values()]).toEqual(['Folder', 'Folder-3', 'Folder-2']);
    const canonical = reference({ directoryId: 'empty', modelPath: 'model.gguf' });
    const name = hostModelPublicName({ name: canonical, directories });
    expect(name).toBe('host/Folder/owner/repo:model.gguf');
    expect(resolveHostModelName({ name, directories })).toBe(canonical);
  });

  it('allows a duplicate suffix beyond the directory ID codec length limit', () => {
    const folderName = 'a'.repeat(255);
    const directories = [directory({ id: 'first', name: folderName }), directory({ id: 'second', name: folderName })];
    const canonical = reference({ directoryId: 'second', modelPath: 'model.gguf' });
    const name = hostModelPublicName({ name: canonical, directories });

    expect(name).toBe(`host/${folderName}-2/owner/repo:model.gguf`);
    expect(resolveHostModelName({ name, directories })).toBe(canonical);
  });

  it.each(['user/model.gguf', 'hf.co/owner/repo:model.gguf', 'remote-model'])('preserves non-host model %s', name => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    expect(hostModelPublicName({ name, directories })).toBe(name);
    expect(resolveHostModelName({ name, directories })).toBe(name);
  });

  it.each([
    'host/unknown/owner/repo:model.gguf',
    'host//owner/repo:model.gguf',
    'host/%zz/owner/repo:model.gguf',
    'host/%4Dodels/owner/repo:model.gguf',
    'host/Models/owner/repo:nested%2fmodel.gguf',
    'host/Models/owner/repo:..%2Fmodel.gguf',
    'host/Models/owner/repo:%2Fmodel.gguf',
    'host/Models/owner/repo:weights%5Cmodel.gguf',
    'host/Models/owner/repo:model.gguf%00',
    'host/Models/owner/repo:model.gguf/extra',
    'host/Models/owner/repo:',
    'host/Models/owner/repo',
    'host/root/owner/repo',
  ])('rejects missing or malformed host names without another storage fallback: %s', name => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    expect(() => resolveHostModelName({ name, directories })).toThrow('missing-model');
  });
});

describe('public host names at the inventory schema boundary', () => {
  it('accepts an encoded Unicode alias longer than the canonical ID and 512 characters', () => {
    const directories = [directory({ id: 'root', name: '日'.repeat(255) })];
    const id = reference({ directoryId: 'root', modelPath: 'nested/model.gguf' });
    const name = hostModelPublicName({ name: id, directories });

    expect(name.length).toBeGreaterThan(1024);
    expect(name).not.toBe(id);
    expect(modelSchema.safeParse({ id, name, size: 128, importedAt: 1 }).success).toBe(true);
    expect(resolveHostModelName({ name, directories })).toBe(id);
  });

  it('retains the 512-character name boundary for ordinary inventory models', () => {
    const model = { id: 'user/model.gguf', size: 128, importedAt: 1 };
    expect(modelSchema.safeParse({ ...model, name: 'a'.repeat(512) }).success).toBe(true);
    expect(modelSchema.safeParse({ ...model, name: 'a'.repeat(513) }).success).toBe(false);
  });
});
