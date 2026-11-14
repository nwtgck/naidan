// @vitest-environment node
// !!! ALLOW-EXTERNAL-COMMAND tar:* !!! -- Exercise the upload workflow archive exclusions against temporary package files.
// !!! ALLOW-EXTERNAL-COMMAND grep -Eq:* !!! -- Verify the workflow inventory pattern with synthetic archive paths.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runCommandSync } from './command';

it.runIf(process.platform === 'linux')('the upload workflow omits native Wasm from both runtime dependencies, not host helpers', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/upload-node-modules.yml'), 'utf8');
  const excludes = [...workflow.matchAll(/--exclude='([^']+)'/gu)].map(match => `--exclude=${match[1]}`);
  expect(excludes).toContain('--exclude=node_modules/llama-cpp-browser-core/*.wasm');
  expect(excludes).toContain('--exclude=node_modules/stable-diffusion-cpp-browser-core/*.wasm');
  const check = workflow.match(/if grep -Eq '([^']+)' "\$contents"/u)?.[1];
  if (!check) {
    throw new Error('Missing post-compression inventory verification');
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bicore-archive-'));
  using _cleanupResource = {
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
  const wasm = [
    'node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles/cpu/browser/core.wasm',
    'node_modules/stable-diffusion-cpp-browser-core/runtimes/stable-diffusion-cpp-browser-core/profiles/webgpu/browser/core.wasm',
    'node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles/cpu/core.wasm',
    'node_modules/stable-diffusion-cpp-browser-core/stable-diffusion-cpp-browser-core/profiles/cpu/core.wasm',
  ];
  const kept = wasm.map(name => name.replace(/\.wasm$/u, '.mjs'));
  kept.push('node_modules/other-package/independent.wasm');
  for (const name of [...wasm, ...kept]) {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, name);
  }
  const archive = path.join(directory, 'test.tar');
  const created = runCommandSync({ argv: ['tar', ...excludes, '-cf', archive, 'node_modules'], options: { cwd: directory, encoding: 'utf8', timeout: 5000 } });
  expect(created.error).toBeUndefined();
  expect(created.status, created.stderr).toBe(0);
  const listed = runCommandSync({ argv: ['tar', '-tf', archive], options: { encoding: 'utf8', timeout: 5000 } });
  expect(listed.error).toBeUndefined();
  expect(listed.status, listed.stderr).toBe(0);
  const contents = listed.stdout;
  for (const name of wasm) {
    expect(contents.split('\n')).not.toContain(name);
    expect(runCommandSync({ argv: ['grep', '-Eq', check], options: { input: name + '\n', encoding: 'utf8', timeout: 5000 } }).status).toBe(0);
  }
  for (const name of kept) {
    expect(contents.split('\n')).toContain(name);
  }
  expect(runCommandSync({ argv: ['grep', '-Eq', check], options: { input: contents, encoding: 'utf8', timeout: 5000 } }).status).toBe(1);
});
