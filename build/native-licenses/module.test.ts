import { describe, expect, it, vi } from 'vitest';
import type { NormalizedOutputOptions, OutputChunk, PluginContext, FunctionPluginHooks } from 'rolldown';
import type { ResolvedConfig } from 'vite';
import { createLicenseModulePlugins, NAIDAN_LICENSE_MODULE_ID } from '../license-module';
import type { NaidanLicense } from '../../src/01-models/naidan-license';

const packageNotice = { name: 'same-name', version: '1', license: 'MIT', licenseText: 'JavaScript notice' };
const nativeNotice: NaidanLicense = { id: 'native:llama-cpp:one', origin: 'llama.cpp', name: 'same-name', version: null, license: null, licenseText: 'Native notice' };

function fixture() {
  const audit = vi.fn();
  const getNativeDependencies = vi.fn(async ({ watchFile }: { watchFile: (file: string) => void }) => {
    watchFile('/verified/native-license-index.json');
    return [nativeNotice];
  });
  const [plugin] = createLicenseModulePlugins({ getAdditionalDependencies: () => [packageNotice], getNativeDependencies, onBuildDependenciesCollected: audit });
  if (!plugin || typeof plugin.configResolved !== 'function' || typeof plugin.load !== 'function' || typeof plugin.renderChunk !== 'function' || typeof plugin.generateBundle !== 'function') {
    throw new Error('Expected direct license plugin hooks');
  }
  const addWatchFile = vi.fn();
  const context = { addWatchFile } as unknown as PluginContext;
  const chunk = { type: 'chunk', fileName: 'assets/licenses.js', name: 'licenses', moduleIds: ['\0' + NAIDAN_LICENSE_MODULE_ID], modules: {}, isDynamicEntry: true, isEntry: false } as OutputChunk;
  const options = {} as NormalizedOutputOptions;
  const meta = { chunks: { [chunk.fileName]: chunk } } as Parameters<FunctionPluginHooks['renderChunk']>[3];
  return { plugin: { configResolved: plugin.configResolved, load: plugin.load, renderChunk: plugin.renderChunk, generateBundle: plugin.generateBundle }, context, chunk, options, meta, audit, getNativeDependencies, addWatchFile };
}

describe('license module native payload hooks without application builds', () => {
  it('collects native notices only in the lazy chunk before hashing and keeps the package audit unchanged', async () => {
    const value = fixture();
    const { plugin, context, chunk, options, meta } = value;
    await plugin.configResolved.call(context, { command: 'build', root: process.cwd() } as ResolvedConfig);
    const loaded = await plugin.load.call(context, '\0' + NAIDAN_LICENSE_MODULE_ID);
    if (typeof loaded !== 'string') {
      throw new Error('Expected module source');
    }
    expect(value.getNativeDependencies).not.toHaveBeenCalled();
    expect(await plugin.renderChunk.call(context, 'entry', { ...chunk, moduleIds: ['app'], isEntry: true, isDynamicEntry: false }, options, meta)).toBeUndefined();
    expect(value.getNativeDependencies).not.toHaveBeenCalled();
    const rendered = await plugin.renderChunk.call(context, loaded, chunk, options, meta);
    if (rendered === null || rendered === undefined || typeof rendered === 'string' || !('code' in rendered) || typeof rendered.code !== 'string') {
      throw new Error('Expected transformed source');
    }
    const reconstructed: unknown = new Function(rendered.code.replace('export default licenses;', 'return licenses;'))();
    expect(reconstructed).toEqual([packageNotice, nativeNotice]);
    expect(value.addWatchFile).toHaveBeenCalledWith('/verified/native-license-index.json');
    await plugin.generateBundle.call(context, options, { [chunk.fileName]: chunk }, false);
    expect(value.audit).toHaveBeenCalledWith({ dependencies: [packageNotice] });
  });

  it('fails a build instead of silently dropping native notices', async () => {
    const value = fixture();
    const { plugin, context, chunk, options, meta } = value;
    await plugin.configResolved.call(context, { command: 'build', root: process.cwd() } as ResolvedConfig);
    value.getNativeDependencies.mockRejectedValue(new Error('missing native notice'));
    await expect(plugin.renderChunk.call(context, '__NAIDAN_LICENSE_PAYLOAD_96f704f8__', chunk, options, meta)).rejects.toThrow('missing native notice');
  });

  it('rejects an eager native license chunk before collecting any payload', async () => {
    const value = fixture();
    const { plugin, context, chunk, options, meta } = value;
    await expect(plugin.renderChunk.call(context, '', { ...chunk, isEntry: true }, options, meta)).rejects.toThrow('lazy dynamic chunk');
    expect(value.getNativeDependencies).not.toHaveBeenCalled();
  });
});
