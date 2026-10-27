import { describe, expect, it, vi } from 'vitest';
import { readNativeLicenseDependencies } from './load';
import type { NativeLicenseSource } from './collect';

function fixture() {
  const bodies = new Map<string, Uint8Array>([
    ['LICENSE', Buffer.from('A native notice')],
    ['native-license-index.json', Buffer.from(JSON.stringify({ components: [{ id: 'one', name: 'One', version: null, license: null, notices: [{ path: 'LICENSE' }] }] }))],
  ]);
  const source: NativeLicenseSource = {
    runtime: 'stable-diffusion-cpp',
    rootDir: '/external',
    kind: 'external',
    files: new Set(bodies.keys()),
    manifestPaths: ['/external/manifest.json', '/external/image/manifest.json'],
    readArtifact({ relative }) {
      const data = bodies.get(relative);
      if (data === undefined) {
        throw new Error('Missing fixture');
      }
      return { data, filePath: `/external/image/${relative}` };
    },
  };
  return { source, bodies, watchFile: vi.fn() };
}

describe('external native license JSON boundary', () => {
  it('loads the selected external data instead of the installed SD JSON', async () => {
    const value = fixture();
    const result = await readNativeLicenseDependencies(value);
    expect(result).toEqual([{
      id: 'native:stable-diffusion-cpp:one',
      origin: 'stable-diffusion.cpp',
      name: 'One',
      version: null,
      license: null,
      licenseText: `\
===== LICENSE =====
A native notice`,
    }]);
    expect(value.watchFile.mock.calls.flat()).toEqual(['/external/manifest.json', '/external/image/manifest.json', '/external/image/native-license-index.json', '/external/image/LICENSE']);
  });

  it.each([{}, { components: [null] }, { components: [{ id: 'x', name: 4 }] }])('validates arbitrary external structures: %j', async data => {
    const value = fixture();
    value.bodies.set('native-license-index.json', Buffer.from(JSON.stringify(data)));
    await expect(readNativeLicenseDependencies(value)).rejects.toThrow();
  });

  it('rejects missing new artifacts, malformed JSON, invalid UTF-8 and changed files', async () => {
    const value = fixture();
    await expect(readNativeLicenseDependencies({ ...value, source: { ...value.source, files: new Set(['LICENSE']) } })).rejects.toThrow('install bicore artifacts');
    value.bodies.set('native-license-index.json', Buffer.from('{'));
    await expect(readNativeLicenseDependencies(value)).rejects.toThrow();
    value.bodies.set('native-license-index.json', Uint8Array.from([255]));
    await expect(readNativeLicenseDependencies(value)).rejects.toThrow();
    await expect(readNativeLicenseDependencies({
      ...value,
      source: {
        ...value.source,
        readArtifact() {
          throw new Error('integrity mismatch');
        },
      },
    })).rejects.toThrow('integrity mismatch');
  });
});
