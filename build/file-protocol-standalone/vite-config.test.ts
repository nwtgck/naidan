import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';
import {
  createStandaloneWorker,
  debugGetStandaloneWorkerRuntimeDiagnostics,
} from '../../src/features/file-protocol-standalone/worker/standalone-worker-runtime-unavailable';
import { FILE_PROTOCOL_STANDALONE_WORKERS } from './worker-definitions';

async function loadAliases(mode: string): Promise<readonly { find: string | RegExp, replacement: string }[]> {
  const loaded = await loadConfigFromFile({ command: 'build', mode }, undefined, process.cwd());
  if (loaded === null) throw new Error(`Expected Vite config to load for ${mode}`);
  const aliases = loaded.config.resolve?.alias;
  if (!Array.isArray(aliases)) throw new Error(`Expected array aliases for ${mode}`);
  return aliases;
}

function findAliasForId({ aliases, id }: {
  aliases: readonly { find: string | RegExp, replacement: string }[],
  id: string,
}): { find: string | RegExp, replacement: string } | undefined {
  return aliases.find(({ find }) => typeof find === 'string' ? find === id : find.test(id));
}

describe('file protocol standalone Vite mode resolution', () => {
  it('fails explicitly if an unavailable standalone Worker factory is called', async () => {
    await expect(createStandaloneWorker()).rejects.toThrow(
      'The file-protocol standalone Worker runtime is unavailable outside standalone builds.',
    );
    expect(() => debugGetStandaloneWorkerRuntimeDiagnostics()).toThrow(
      'The file-protocol standalone Worker runtime is unavailable outside standalone builds.',
    );
  });

  it('resolves the standalone runtime virtual import in hosted mode without enabling the standalone plugin', async () => {
    const aliases = await loadAliases('hosted');
    const runtimeAlias = aliases.find(alias => alias.find === 'virtual:naidan-standalone-worker-runtime');

    expect(runtimeAlias?.replacement).toBe(path.resolve(
      process.cwd(),
      'src/features/file-protocol-standalone/worker/standalone-worker-runtime-unavailable.ts',
    ));
  });

  it('leaves the standalone runtime virtual import to the standalone plugin in standalone mode', async () => {
    const aliases = await loadAliases('standalone');

    expect(aliases.some(alias => alias.find === 'virtual:naidan-standalone-worker-runtime')).toBe(false);
  });

  it('resolves standalone Worker virtual imports to the unavailable runtime in hosted mode', async () => {
    const aliases = await loadAliases('hosted');
    const unavailablePath = path.resolve(
      process.cwd(),
      'src/features/file-protocol-standalone/worker/standalone-worker-runtime-unavailable.ts',
    );

    for (const { virtualId } of FILE_PROTOCOL_STANDALONE_WORKERS) {
      expect(findAliasForId({ aliases, id: virtualId })?.replacement).toBe(unavailablePath);
    }

    expect(findAliasForId({
      aliases,
      id: 'virtual:file-protocol-standalone/worker/unregistered-worker',
    })).toBeUndefined();
  });

  it('resolves standalone Worker virtual imports to the unavailable runtime in development mode', async () => {
    const aliases = await loadAliases('development');
    const unavailablePath = path.resolve(
      process.cwd(),
      'src/features/file-protocol-standalone/worker/standalone-worker-runtime-unavailable.ts',
    );

    for (const { virtualId } of FILE_PROTOCOL_STANDALONE_WORKERS) {
      expect(findAliasForId({ aliases, id: virtualId })?.replacement).toBe(unavailablePath);
    }
  });

  it('keeps standalone Worker virtual imports owned by the standalone plugin in standalone mode', async () => {
    const aliases = await loadAliases('standalone');

    for (const { virtualId } of FILE_PROTOCOL_STANDALONE_WORKERS) {
      expect(findAliasForId({ aliases, id: virtualId })).toBeUndefined();
    }
  });

  it('keeps test Worker mocks ahead of the non-standalone unavailable fallback', async () => {
    const aliases = await loadAliases('test');
    const testMockPath = path.resolve(process.cwd(), 'src/test-mocks/standalone-worker.ts');

    for (const { virtualId } of FILE_PROTOCOL_STANDALONE_WORKERS) {
      expect(findAliasForId({ aliases, id: virtualId })?.replacement).toBe(testMockPath);
    }
  });
});
