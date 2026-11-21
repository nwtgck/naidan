// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ASSET_SELECTION_CHANGED, READ_ASSET_SELECTION, type AssetSelection } from '../src/logic/pwa/asset-cache-protocol';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '../src/features/transformers-js/runtime/runtime-asset-manifest';
import { buildPWAFixture } from './test-support/pwa-fixture.test-support';
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform.test-support';

const scope = 'https://example.test/naidan/';
const standard = `transformers/${HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants[0].wasm.physicalFileName}`;
const asyncify = `transformers/${HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants[1].mjs.publicFileName}`;
const cpu = 'llama-cpp-browser-runtime/profiles/cpu-wasm32/core.wasm.gz';
const gpu = 'llama-cpp-browser-runtime/profiles/webgpu-wasm64-jspi/core.wasm.gz';
const runtimeArtifacts = {
  'stable-diffusion-cpp-browser': [
    { profile: 'image-a', modulePath: 'image/a.mjs', wasmPath: 'image/a.wasm.gz' },
    { profile: 'image-b', modulePath: 'image/b.mjs', wasmPath: 'image/b.wasm.gz' },
  ],
  'speech-cpp-browser': [
    { profile: 'speech-a', modulePath: 'speech/a.mjs', wasmPath: 'speech/a.wasm.gz' },
    { profile: 'speech-b', modulePath: 'speech/b.mjs', wasmPath: 'speech/b.wasm.gz' },
  ],
} as const;
const packId = 'virtual:naidan-boundary-strings/pack/';
const en = `${packId}en/0000000000000001/0000000000000001`;
const ja = `${packId}ja/0000000000000001/0000000000000001`;
const ko = `${packId}ko/0000000000000001/0000000000000001`;
const secondKo = `${packId}ko/0000000000000003/0000000000000001`;
const directPack = `${packId}pt-BR/0000000000000001/0000000000000001`;
const primaryBoundary = 'virtual:naidan-boundary-strings/boundary/0000000000000001/0000000000000001';
const secondBoundary = 'virtual:naidan-boundary-strings/boundary/0000000000000003/0000000000000001';
const bootstrap = `${packId}es/0000000000000002/0000000000000001`;
const koreanMessage = 'src/strings/messages/Test__localized_message/ko.ts';
const crossLocaleMessage = 'src/strings/messages/Test__shared_message/ko.ts';
const hidden = '.well-known/future-asset';
const cpuModule = 'virtual:llama-test-cpu';
const gpuModule = 'virtual:llama-test-gpu';
let root: string | undefined;
let fixture: Awaited<ReturnType<typeof buildPWAFixture>>;
let english: string;
let japanese: string;
let korean: string;
let secondKorean: string;
let koreanOnly: string;
let sharedWithEnglish: string;
let direct: string;
let startup: string;
let cpuScript: string;
let gpuScript: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'naidan-selective-cache-'));
  await Promise.all([
    mkdir(path.join(root, 'public', 'transformers'), { recursive: true }),
    mkdir(path.join(root, 'public', '.well-known'), { recursive: true }),
    mkdir(path.dirname(path.join(root, 'public', cpu)), { recursive: true }),
    mkdir(path.dirname(path.join(root, 'public', gpu)), { recursive: true }),
    mkdir(path.join(root, 'public', 'image'), { recursive: true }),
    mkdir(path.join(root, 'public', 'speech'), { recursive: true }),
    mkdir(path.dirname(path.join(root, koreanMessage)), { recursive: true }),
    mkdir(path.dirname(path.join(root, crossLocaleMessage)), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, koreanMessage), 'export const message = () => "korean-message-only-marker";'),
    writeFile(path.join(root, crossLocaleMessage), 'export const shared = () => "shared-with-english-message-marker";'),
  ]);
  const modules = new Map([
    ['virtual:audit-route', `
      import { loaders as primary } from ${JSON.stringify(primaryBoundary)};
      import { loaders as secondary } from ${JSON.stringify(secondBoundary)};
      export const loaders = [...primary, ...secondary, () => import(${JSON.stringify(directPack)})];
    `],
    [primaryBoundary, `export const loaders = [${[en, ja, ko, directPack].map(id => `() => import(${JSON.stringify(id)})`).join(', ')}];`],
    [secondBoundary, `export const loaders = [() => import(${JSON.stringify(secondKo)})];`],
    [en, `import { shared } from "/${crossLocaleMessage}"; export default { name: "english-pack-marker", shared };`],
    [ja, 'export default "japanese-pack-marker";'],
    [ko, `import { message } from "/${koreanMessage}"; import { shared } from "/${crossLocaleMessage}";
      export default { name: "korean-first-pack-marker", message, shared };`],
    [secondKo, `import { message } from "/${koreanMessage}"; export default { name: "korean-second-pack-marker", message };`],
    [directPack, 'export default "direct-portuguese-pack-marker";'],
    [bootstrap, 'export default "startup-pack-marker";'],
  ]);
  await writeFile(path.join(root, 'llama-probe.js'), `self.onmessage = async event => {
    const runtime = event.data === 'cpu' ? await import(${JSON.stringify(cpuModule)}) : await import(${JSON.stringify(gpuModule)});
    self.postMessage(runtime.default);
  };`);
  fixture = await buildPWAFixture({
    root,
    buildId: 'selective-fixture',
    publicFiles: new Map([
      [standard, 'standard bytes'], [asyncify, 'asyncify bytes'], [cpu, 'cpu bytes'], [gpu, 'gpu bytes'], [hidden, 'unknown bytes'],
      ['image/shared.mjs', 'shared image helper'],
      ...Object.values(runtimeArtifacts).flat().flatMap(({ modulePath, wasmPath }) => [[modulePath, modulePath], [wasmPath, wasmPath]] as const),
    ]),
    getRuntimeArtifacts: () => runtimeArtifacts,
    entrySource: `console.info(__PWA_BUILD_ID__); if (typeof document !== 'undefined') {
      import('virtual:audit-route').then(({ loaders }) => globalThis.loaders = loaders);
      import(${JSON.stringify(bootstrap)}).then(module => console.log(module.default));
      globalThis.llamaProbe = new Worker(new URL('./llama-probe.js', import.meta.url), { type: 'module' });
    }`,
    worker: {
      profileForModule: ({ id }) => id === `\0${cpuModule}` ? 'cpu-wasm32' : id === `\0${gpuModule}` ? 'webgpu-wasm64-jspi' : undefined,
      plugins: () => [{
        name: 'test-llama-runtime-modules',
        resolveId(id) {
          return id === cpuModule || id === gpuModule ? `\0${id}` : undefined;
        },
        load(id) {
          if (id === `\0${cpuModule}`) {
            return 'export default "llama-cpu-script-marker";';
          }
          if (id === `\0${gpuModule}`) {
            return 'export default "llama-gpu-script-marker";';
          }
          return undefined;
        },
      }],
    },
    plugins: [{
      name: 'test-pwa-locale-packs',
      resolveId(id) {
        return modules.has(id) ? `\0${id}` : undefined;
      },
      load(id) {
        return id.startsWith('\0') ? modules.get(id.slice(1)) : undefined;
      },
    }],
  });
  function fileForMarker({ marker }: { marker: string }): string {
    const file = [...fixture.files].find(([name, bytes]) => name.endsWith('.js') && !name.endsWith('sw.js') && bytes.toString().includes(marker))?.[0];
    if (!file) {
      throw new Error(`Missing pack: ${marker}`);
    }
    return file;
  }
  english = fileForMarker({ marker: 'english-pack-marker' });
  japanese = fileForMarker({ marker: 'japanese-pack-marker' });
  korean = fileForMarker({ marker: 'korean-first-pack-marker' });
  secondKorean = fileForMarker({ marker: 'korean-second-pack-marker' });
  koreanOnly = fileForMarker({ marker: 'korean-message-only-marker' });
  sharedWithEnglish = fileForMarker({ marker: 'shared-with-english-message-marker' });
  direct = fileForMarker({ marker: 'direct-portuguese-pack-marker' });
  startup = fileForMarker({ marker: 'startup-pack-marker' });
  cpuScript = fileForMarker({ marker: 'llama-cpu-script-marker' });
  gpuScript = fileForMarker({ marker: 'llama-gpu-script-marker' });
}, 60_000);

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

function setup({ initialSelection, beforeFetch }: {
  initialSelection: AssetSelection | undefined;
  beforeFetch: (({ file, signal }: { file: string; signal: AbortSignal | undefined }) => Promise<void>) | undefined;
}) {
  let selection = initialSelection;
  let offline = false;
  const storage = new MemoryCacheStorage();
  const clients = new TestClients();
  function addPage({ id, getSelection }: { id: string; getSelection: () => AssetSelection | undefined }) {
    clients.clients.set(id, {
      id,
      type: 'window',
      url: scope,
      postMessage(message, transfer) {
        expect(message).toEqual({ type: READ_ASSET_SELECTION });
        const port = transfer[0] as MessagePort;
        port.postMessage(getSelection());
      },
    });
  }
  addPage({ id: 'page', getSelection: () => selection });
  const requested: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const file = url.pathname.slice(new URL(scope).pathname.length);
    requested.push(file);
    if (offline) {
      throw new TypeError('offline');
    }
    await beforeFetch?.({ file, signal: init?.signal ?? undefined });
    const bytes = fixture.files.get(file);
    if (!bytes) {
      return new Response('missing', { status: 404 });
    }
    if (init?.integrity && init.integrity !== `sha256-${createHash('sha256').update(bytes).digest('base64')}`) {
      throw new TypeError('incorrect integrity');
    }
    const contentType = /\.(?:m?js)$/.test(file) ? 'text/javascript' : 'application/octet-stream';
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } });
  };
  const worker = createWorkerHarness({ script: fixture.script, scope, cacheStorage: storage, clients, fetch });
  return {
    worker,
    storage,
    requested,
    addPage,
    setSelection(next: AssetSelection) {
      selection = next;
    },
    disconnect() {
      offline = true;
    },
  };
}

it('installs the union of live selections, startup packs, and unknown files', async () => {
  const f = setup({ initialSelection: { locales: ['en'], transformers: 'standard', llama: ['cpu-wasm32'] }, beforeFetch: undefined });
  f.addPage({ id: 'second', getSelection: () => ({ locales: ['ja'], transformers: 'standard', llama: ['cpu-wasm32'] }) });
  await f.worker.lifecycle('install');
  for (const file of [english, japanese, direct, startup, hidden, standard, cpu, cpuScript]) {
    expect(f.requested).toContain(file);
  }
  expect(f.requested).not.toContain(asyncify);
  expect(f.requested).not.toContain(gpu);
  expect(f.requested).not.toContain(gpuScript);
  f.disconnect();
  expect((await f.worker.request({ url: `${scope}${hidden}` })).status).toBe(200);
  expect((await f.worker.request({ url: `${scope}${japanese}` })).status).toBe(200);
});

it('defers a split message only when every pack that imports it has the same locale', async () => {
  expect(koreanOnly).not.toBe(korean);
  expect(koreanOnly).not.toBe(secondKorean);
  expect(sharedWithEnglish).not.toBe(english);
  const englishSelection = setup({ initialSelection: { locales: ['en'] }, beforeFetch: undefined });
  await englishSelection.worker.lifecycle('install');
  expect(englishSelection.requested).toContain(sharedWithEnglish);
  for (const file of [korean, secondKorean, koreanOnly]) {
    expect(englishSelection.requested).not.toContain(file);
  }

  const koreanSelection = setup({ initialSelection: { locales: ['ko'] }, beforeFetch: undefined });
  await koreanSelection.worker.lifecycle('install');
  for (const file of [korean, secondKorean, koreanOnly, sharedWithEnglish]) {
    expect(koreanSelection.requested).toContain(file);
  }
  koreanSelection.disconnect();
  expect((await koreanSelection.worker.request({ url: `${scope}${koreanOnly}` })).status).toBe(200);
});

it('falls back to saving every ambiguous selection asset for an older page', async () => {
  const f = setup({ initialSelection: undefined, beforeFetch: undefined });
  await f.worker.lifecycle('install');
  for (const file of [english, japanese, korean, secondKorean, koreanOnly, standard, asyncify, cpu, gpu, cpuScript, gpuScript]) {
    expect(f.requested).toContain(file);
  }
  expect(f.requested).not.toContain('naidan-standalone.zip');
});

it('waits for automatic runtime selection and only installs the resulting profile', async () => {
  const firstReply = Promise.withResolvers<void>();
  let detected = false;
  const f = setup({ initialSelection: { locales: ['en'], llama: ['cpu-wasm32'] }, beforeFetch: undefined });
  f.addPage({
    id: 'still-probing',
    getSelection: () => {
      firstReply.resolve();
      return {
        locales: ['en'],
        runtimes: { 'llama-cpp-browser': detected ? { status: 'known', profiles: ['cpu-wasm32'] } : { status: 'pending' } },
      };
    },
  });
  const installing = f.worker.lifecycle('install');
  await firstReply.promise;
  detected = true;
  await installing;
  expect(f.requested).toContain(cpu);
  expect(f.requested).not.toContain(gpu);
});

it('falls back after the runtime detection deadline without saving the manual archive', async () => {
  const f = setup({
    initialSelection: { locales: ['en'], runtimes: { 'llama-cpp-browser': { status: 'pending' } } },
    beforeFetch: undefined,
  });
  await f.worker.lifecycle('install');
  expect(f.requested).toEqual(expect.arrayContaining([cpu, gpu]));
  expect(f.requested).not.toContain('naidan-standalone.zip');
}, 10_000);

it('uses the manifest candidates for image and speech selection and retains shared assets', async () => {
  const f = setup({
    initialSelection: {
      locales: ['en'],
      runtimes: {
        'stable-diffusion-cpp-browser': { status: 'known', profiles: ['image-b'] },
        'speech-cpp-browser': { status: 'known', profiles: ['speech-a'] },
      },
    },
    beforeFetch: undefined,
  });
  f.addPage({
    id: 'second-engine-selection',
    getSelection: () => ({
      locales: ['en'],
      runtimes: {
        'stable-diffusion-cpp-browser': { status: 'known', profiles: ['image-b'] },
        'speech-cpp-browser': { status: 'known', profiles: [] },
      },
    }),
  });
  await f.worker.lifecycle('install');
  expect(f.requested).toEqual(expect.arrayContaining(['image/shared.mjs', 'image/b.mjs', 'image/b.wasm.gz', 'speech/a.mjs', 'speech/a.wasm.gz']));
  for (const file of ['image/a.mjs', 'image/a.wasm.gz', 'speech/b.mjs', 'speech/b.wasm.gz']) {
    expect(f.requested).not.toContain(file);
  }
});

it('treats a profile from an older deployment as unknown only for its engine', async () => {
  const f = setup({
    initialSelection: {
      locales: ['en'],
      runtimes: {
        'stable-diffusion-cpp-browser': { status: 'known', profiles: ['older-image-profile'] },
        'speech-cpp-browser': { status: 'known', profiles: [] },
      },
    },
    beforeFetch: undefined,
  });
  await f.worker.lifecycle('install');
  expect(f.requested).toEqual(expect.arrayContaining(['image/a.wasm.gz', 'image/b.wasm.gz', 'image/shared.mjs']));
  expect(f.requested).not.toContain('speech/a.wasm.gz');
  expect(f.requested).not.toContain('speech/b.wasm.gz');
});

it('rejects a permanent exclusion reinserted after the manifest transform', async () => {
  const lateBuildRoot = await mkdtemp(path.join(os.tmpdir(), 'naidan-pwa-late-entry-'));
  await using _cleanup = {
    async [Symbol.asyncDispose]() {
      await rm(lateBuildRoot, { force: true, recursive: true });
    },
  };
  await expect(buildPWAFixture({
    root: lateBuildRoot,
    buildId: 'unexpected-manifest-entry',
    additionalManifestEntries: [{ url: 'naidan-standalone-ja.zip', revision: 'would-be-reinserted' }],
  })).rejects.toThrow('Unexpected Hosted PWA manifest entry: naidan-standalone-ja.zip');
});

it('cancels a stalled obsolete request and waits for the new language and runtime', async () => {
  const started = Promise.withResolvers<void>();
  const f = setup({
    initialSelection: { locales: ['en'], transformers: 'standard', llama: ['cpu-wasm32'] },
    async beforeFetch({ file, signal }) {
      if (file !== english) {
        return;
      }
      started.resolve();
      if (!signal) {
        throw new Error('Expected an abortable download');
      }
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const installing = f.worker.lifecycle('install');
  await started.promise;
  f.setSelection({ locales: ['ja'], transformers: 'asyncify', llama: ['webgpu-wasm64-jspi'] });
  await f.worker.message({ clientId: 'page', data: { type: ASSET_SELECTION_CHANGED }, replyPort: false });
  await installing;
  expect(f.requested).toContain(japanese);
  expect(f.requested).toContain(asyncify);
  expect(f.requested).toContain(gpu);
  expect(f.requested).toContain(gpuScript);
  f.disconnect();
  expect((await f.worker.request({ url: `${scope}${japanese}` })).status).toBe(200);
});

it('saves an excluded asset after ordinary use and can still return a response when storage is full', async () => {
  const f = setup({ initialSelection: { locales: ['en'], transformers: 'standard' }, beforeFetch: undefined });
  await f.worker.lifecycle('install');
  expect(f.requested).not.toContain(japanese);
  expect((await f.worker.request({ url: `${scope}${japanese}` })).status).toBe(200);
  const name = (await f.storage.keys()).find(key => key.startsWith('naidan-pwa-verified-assets'));
  if (!name) {
    throw new Error('Missing verified assets cache');
  }
  const cache = await f.storage.open(name);
  using _mock = {
    [Symbol.dispose]() {
      vi.restoreAllMocks();
    },
  };
  vi.spyOn(cache, 'put').mockRejectedValue(new DOMException('Capacity reached', 'QuotaExceededError'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await (await f.worker.request({ url: `${scope}${asyncify}` })).text()).toBe('asyncify bytes');
  f.disconnect();
  expect((await f.worker.request({ url: `${scope}${japanese}` })).status).toBe(200);
});

it('rejects a Hosted asset added after Workbox collected its manifest', async () => {
  const lateBuildRoot = await mkdtemp(path.join(os.tmpdir(), 'naidan-pwa-late-asset-'));
  await using _cleanup = {
    async [Symbol.asyncDispose]() {
      await rm(lateBuildRoot, { force: true, recursive: true });
    },
  };
  await expect(buildPWAFixture({
    root: lateBuildRoot,
    buildId: 'late-asset',
    plugins: [{
      name: 'emit-after-workbox',
      closeBundle: {
        order: 'post',
        sequential: true,
        handler: () => writeFile(path.join(lateBuildRoot, 'dist', 'late-asset.bin'), 'not in the manifest'),
      },
    }],
  })).rejects.toThrow('Hosted PWA manifest is missing assets: late-asset.bin');
});
