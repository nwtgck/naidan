import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';

async function loadAliases(mode: string): Promise<readonly { find: string | RegExp, replacement: string }[]> {
  const loaded = await loadConfigFromFile({ command: 'build', mode }, undefined, process.cwd());
  if (loaded === null) throw new Error(`Expected Vite config to load for ${mode}`);
  const aliases = loaded.config.resolve?.alias;
  if (!Array.isArray(aliases)) throw new Error(`Expected array aliases for ${mode}`);
  return aliases;
}

describe('file protocol standalone Vite mode resolution', () => {
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
});
