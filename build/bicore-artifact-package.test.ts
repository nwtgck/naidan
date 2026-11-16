// !!! ALLOW-EXTERNAL-COMMAND node --experimental-strip-types:* !!! -- Verify native build imports without the test transformer.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runCommand } from './command.ts';
import { pathToFileURL } from 'node:url';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readBicoreArtifactPackage } from './bicore-artifact-package';

type Runtime = 'llama-cpp' | 'stable-diffusion-cpp' | 'speech-cpp';
type Entry = { path: string, bytes: number, sha256: string };

function fixture({ runtime, formatVersion }: { runtime: Runtime, formatVersion: 5 | 6 }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'naidan-bicore-manifest-'));
  const prefix = `runtimes/${runtime}-browser-core/`;
  const relative = 'profiles/fixture/browser/core.wasm';
  const payload = Buffer.from('synthetic payload; not executable Wasm');
  const entry = ({ relative, data }: { relative: string, data: Buffer }): Entry => ({ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  const inner = { formatVersion: 2, runtime: runtime as string, sourceCommit: 'a'.repeat(40), files: [entry({ relative, data: payload })] };
  const root = {
    formatVersion: formatVersion as number,
    sourceCommit: inner.sourceCommit,
    runtimes: {
      'llama-cpp': { manifest: 'runtimes/llama-cpp-browser-core/manifest.json', manifestFormatVersion: 2 },
      'stable-diffusion-cpp': { manifest: 'runtimes/stable-diffusion-cpp-browser-core/manifest.json', manifestFormatVersion: 2 },
      ...(formatVersion === 6 ? { 'speech-cpp': { manifest: 'runtimes/speech-cpp-browser-core/manifest.json', manifestFormatVersion: 2 } } : {}),
    },
    files: [] as Entry[],
  };
  const filePath = path.join(directory, prefix, relative);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, payload);
  function save() {
    const data = Buffer.from(JSON.stringify(inner));
    writeFileSync(path.join(directory, prefix, 'manifest.json'), data);
    root.files = [entry({ relative: prefix + 'manifest.json', data })];
    saveRoot();
  }
  function saveRoot() {
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(root));
  }
  save();
  return {
    directory,
    prefix,
    relative,
    filePath,
    payload,
    inner,
    root,
    save,
    saveRoot,
    read() {
      return readBicoreArtifactPackage({ directory, runtime, maxFileBytes: undefined });
    },
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe.each([
  { runtime: 'llama-cpp', formatVersion: 5 },
  { runtime: 'stable-diffusion-cpp', formatVersion: 5 },
  { runtime: 'llama-cpp', formatVersion: 6 },
  { runtime: 'stable-diffusion-cpp', formatVersion: 6 },
  { runtime: 'speech-cpp', formatVersion: 6 },
] as const)('bicore $runtime root $formatVersion manifest boundary', ({ runtime, formatVersion }) => {
  it('validates metadata without touching payloads or the unselected runtime', () => {
    using test = fixture({ runtime, formatVersion });
    rmSync(test.filePath);
    const artifact = test.read();
    expect(artifact.sourceCommit).toBe(test.root.sourceCommit);
    expect(artifact.rootMetadata).toEqual({ formatVersion, sourceCommit: test.root.sourceCommit });
    expect(artifact.runtimeMetadata).toEqual(test.inner);
    expect(artifact.manifest).toEqual(test.inner);
    expect([...artifact.files.keys()]).toEqual([test.relative]);
    expect(artifact.manifestPaths).toHaveLength(2);
    expect(() => artifact.readArtifact({ relative: test.relative })).toThrow();
    writeFileSync(test.filePath, test.payload);
    expect(artifact.readArtifact({ relative: test.relative }).data).toEqual(test.payload);
  });

  it('checks content when a payload is actually requested', () => {
    using test = fixture({ runtime, formatVersion });
    writeFileSync(test.filePath, Buffer.alloc(test.payload.length));
    const artifact = test.read();
    expect(() => artifact.readArtifact({ relative: test.relative })).toThrow('integrity mismatch');
  });

  it('checks actual size before allocating an oversized payload', () => {
    using test = fixture({ runtime, formatVersion });
    const artifact = test.read();
    truncateSync(test.filePath, 1024 * 1024);
    expect(() => artifact.readArtifact({ relative: test.relative })).toThrow('size mismatch');
  });

  it('applies the caller limit even if both inventories agree on size', () => {
    using test = fixture({ runtime, formatVersion });
    const bytes = 4096;
    test.inner.files[0]!.bytes = bytes;
    test.save();
    truncateSync(test.filePath, bytes);
    const artifact = readBicoreArtifactPackage({ directory: test.directory, runtime, maxFileBytes: bytes });
    expect(() => artifact.readArtifact({ relative: test.relative })).toThrow('Oversized');
  });

  it('rejects a root inventory that contains unlisted runtime files', () => {
    using test = fixture({ runtime, formatVersion });
    test.root.files.push({ ...test.root.files[0]!, path: test.prefix + 'unlisted.wasm' });
    test.saveRoot();
    expect(() => test.read()).toThrow('root inventory contains a runtime payload');
  });

  it('rejects a selected manifest absent from the root inventory', () => {
    using test = fixture({ runtime, formatVersion });
    test.root.files.shift();
    test.saveRoot();
    expect(() => test.read()).toThrow('Missing bicore artifact');
  });

  it.each(['bytes', 'sha256'] as const)('rejects mismatched parent %s before reading payloads', field => {
    using test = fixture({ runtime, formatVersion });
    if (field === 'bytes') {
test.root.files[0]!.bytes++;
    } else {
test.root.files[0]!.sha256 = '0'.repeat(64);
    }
    test.saveRoot();
    expect(() => test.read()).toThrow('integrity mismatch');
  });

  it.each(['root', 'inner'] as const)('rejects duplicate %s entries', scope => {
    using test = fixture({ runtime, formatVersion });
    if (scope === 'root') {
      test.root.files.push(test.root.files[0]!);
      test.saveRoot();
    } else {
      test.inner.files.push(test.inner.files[0]!);
      test.save();
    }
    expect(() => test.read()).toThrow('Duplicate');
  });

  it('rejects different source commits and runtime ownership', () => {
    using test = fixture({ runtime, formatVersion });
    test.inner.sourceCommit = 'b'.repeat(40);
    test.save();
    expect(() => test.read()).toThrow('Mixed runtime');
    test.inner.sourceCommit = test.root.sourceCommit;
    test.inner.runtime = runtime === 'llama-cpp' ? 'stable-diffusion-cpp' : 'llama-cpp';
    test.save();
    expect(() => test.read()).toThrow('another runtime');
  });

  it.each(['../escape', '/absolute', 'C:\\absolute', 'a//b', 'a/./b', 'a/../b', 'a\\b'])('rejects an unsafe inventory path %s', unsafe => {
    using test = fixture({ runtime, formatVersion });
    test.inner.files[0]!.path = unsafe;
    test.save();
    expect(() => test.read()).toThrow('Unsafe');
  });

  it('rejects unsafe and unlisted caller paths', () => {
    using test = fixture({ runtime, formatVersion });
    const artifact = test.read();
    expect(() => artifact.readArtifact({ relative: '../manifest.json' })).toThrow('Unsafe');
    expect(() => artifact.readArtifact({ relative: 'missing.wasm' })).toThrow('Missing runtime artifact');
  });

  it('rejects symlinks escaping the package even when bytes match', () => {
    using test = fixture({ runtime, formatVersion });
    using outside = fixture({ runtime, formatVersion });
    rmSync(test.filePath);
    symlinkSync(outside.filePath, test.filePath);
    const artifact = test.read();
    expect(() => artifact.readArtifact({ relative: test.relative })).toThrow('escapes package');
  });

  it('rejects legacy root versions and redirected runtime manifests', () => {
    using test = fixture({ runtime, formatVersion });
    test.root.formatVersion = 3;
    test.saveRoot();
    expect(() => test.read()).toThrow();
    test.root.formatVersion = formatVersion;
    const binding = test.root.runtimes[runtime];
    if (binding === undefined) {
      throw new Error('Missing selected fixture runtime');
    }
    binding.manifest = 'manifest.json';
    test.saveRoot();
    expect(() => test.read()).toThrow();
  });

  it('verifies the selected manifest bytes before parsing', () => {
    using test = fixture({ runtime, formatVersion });
    const manifestPath = path.join(test.directory, test.prefix, 'manifest.json');
    const bytes = readFileSync(manifestPath);
    writeFileSync(manifestPath, Buffer.alloc(bytes.length, 32));
    expect(() => test.read()).toThrow('integrity mismatch');
  });
});

it('keeps speech unavailable in a two-runtime root and requires its binding in root 6', () => {
  using test = fixture({ runtime: 'speech-cpp', formatVersion: 6 });
  test.root.formatVersion = 5;
  test.saveRoot();
  expect(() => test.read()).toThrow('does not include runtime: speech-cpp');
  test.root.formatVersion = 6;
  delete test.root.runtimes['speech-cpp'];
  test.saveRoot();
  expect(() => test.read()).toThrow();
});

// Vitest's transformed imports can accept an extensionless TypeScript dependency
// that Node's native config loader rejects. Exercise the real consumer entries
// in a separate untransformed process, without loading any runtime payload.
it('loads all build consumers through native TypeScript imports', async () => {
  const entries = [
    { file: 'src/features/llama-cpp-browser/build-artifact-package.ts', exported: 'readLlamaArtifactPackage' },
    { file: 'src/features/stable-diffusion-cpp-browser/build-runtime.ts', exported: 'readImageArtifacts' },
    { file: 'src/features/speech-cpp-browser/build-runtime.ts', exported: 'readSpeechArtifacts' },
  ].map(({ file, exported }) => ({ url: pathToFileURL(path.resolve(file)).href, exported }));
  const source = `\
    for (const { url, exported } of ${JSON.stringify(entries)}) {
      const entry = await import(url);
      if (typeof entry[exported] !== 'function') throw new Error('Missing build reader: ' + exported);
    }
    console.log('native bicore build imports passed');
  `;
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), 'native-bicore-imports-'));
  const stdoutPath = path.join(outputDirectory, 'stdout');
  const stderrPath = path.join(outputDirectory, 'stderr');
  using cleanup = {
    [Symbol.dispose]() {
      rmSync(outputDirectory, { recursive: true, force: true });
    },
  };
  using stdout = {
    descriptor: openSync(stdoutPath, 'wx'),
    [Symbol.dispose]() {
      closeSync(this.descriptor);
    },
  };
  using stderr = {
    descriptor: openSync(stderrPath, 'wx'),
    [Symbol.dispose]() {
      closeSync(this.descriptor);
    },
  };
  const child = runCommand({
    argv: ['node', '--experimental-strip-types', '--input-type=module', '--eval', source],
    options: { cwd: process.cwd(), timeout: 10_000, stdio: ['ignore', stdout.descriptor, stderr.descriptor] },
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(status, readFileSync(stderrPath, 'utf8')).toBe(0);
  expect(readFileSync(stdoutPath, 'utf8').trim()).toBe('native bicore build imports passed');
});
