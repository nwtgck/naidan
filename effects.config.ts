import path from 'node:path';
import type { EffectsConfig } from './tools/effects/config.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from './tools/effects/models/registry.ts';
import { selectEffectEntries } from './tools/effects/project.ts';

const tsconfig = 'tsconfig.effects-browser.json';
const files = selectEffectEntries({ root: import.meta.dirname, config: { tsconfig }, files: ['src'] })
  .map(file => path.relative(import.meta.dirname, file).split(path.sep).join('/'));

const config: EffectsConfig = {
  files,
  tsconfig,
  definitions: DEFAULT_EFFECT_DEFINITIONS,
  models: [
    // Vite replaces this reviewed scalar binding. Do not assume arbitrary ambient values are pure.
    { file: 'src/env.d.ts', export: '__BUILD_MODE_IS_TEST__', effects: [], returnValue: 'scalar-value', sha256: '5897d54eb3f7599e58f0b614e4a114b083bd2cf1ad5260a71faafcc2571105d9' },
  ],
  workerTransports: [{
    file: 'src/utils/worker-transport.ts',
    sha256: '702cc58d2e1cf5facbe782f6184b4984b6aa804800adce8a43041ea22a9d82f5',
    wrapExport: 'wrapWorkerRemote',
    exposeExport: 'exposeWorkerRemote',
  }],
  vueModels: [
    { file: 'node_modules/@vue/reactivity/dist/reactivity.d.ts', sha256: '8fa68a409acbfc169f88bc6763ffb2df73b49346a938fd7b75397261995db523' },
    { file: 'node_modules/@vue/runtime-core/dist/runtime-core.d.ts', sha256: 'e6ed4d124f3c7e4e287e7742f3b9cf3d01ae9477e4b8e70d6a95d7061f12bb51' },
  ],
  analysisBudget: 1_000_000,
};
export default config;
