import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NAIDAN_LICENSE_MODULE_ID } from '../license-module';

export const licenseCacheEntrySource = `\
import { probe } from 'cache-probe';
globalThis.probe = probe;
globalThis.loadLicenses = async () => (await import('${NAIDAN_LICENSE_MODULE_ID}')).default;
globalThis.loadIndependent = () => import('./independent.js');
`;

/** A few bytes of installed package data; never installs or compiles bicore. */
export async function createLicenseCacheFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naidan-license-cache-'));
  const packageDirectory = path.join(root, 'node_modules/cache-probe');
  return {
    root,
    packageDirectory,
    async prepare() {
      await fs.mkdir(packageDirectory, { recursive: true });
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'cache-fixture', private: true, type: 'module' }));
      await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/cache-probe': { version: '1.0.0', resolved: 'git+https://example.invalid/bicore#first' },
          'node_modules/unused-dev': { version: '1.0.0', dev: true },
        },
      }));
      await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
        name: 'cache-probe',
        version: '1.0.0',
        license: 'MIT',
        type: 'module',
        main: 'index.js',
      }));
      await fs.writeFile(path.join(packageDirectory, 'index.js'), 'export const probe = "probe-value";');
      await fs.writeFile(path.join(packageDirectory, 'LICENSE'), 'cache-probe license A\n');
      await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><script type="module" src="/entry.js"></script>');
      await fs.writeFile(path.join(root, 'entry.js'), licenseCacheEntrySource);
      await fs.writeFile(path.join(root, 'independent.js'), 'export const value = "independent-marker";');
    },
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
