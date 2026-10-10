import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeEffects, runEffects } from '../index.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';
import type { EffectsConfig } from '../config.ts';

export function createFixture({ files, entries }: { files: Readonly<Record<string, string>>, entries: readonly string[] }): {
  root: string,
  config: EffectsConfig,
  check: () => ReturnType<typeof analyzeEffects>,
  fix: () => ReturnType<typeof runEffects>,
  dispose: () => void,
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-effects-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      lib: ['ES2023', 'DOM'],
      allowImportingTsExtensions: true,
    },
    files: entries,
  }));
  const config: EffectsConfig = {
    files: entries,
    tsconfig: 'tsconfig.json',
    analysisBudget: 100_000,
    definitions: [...DEFAULT_EFFECT_DEFINITIONS, { name: 'hoge', arguments: 'none' }],
    models: [],
    workerTransports: [],
    vueModels: [],
  };
  return {
    root,
    config,
    check: () => {
      const program = createEffectsProgram({ root, config, overlays: new Map() });
      const result = analyzeEffects({ program, root, config });
      result.diagnostics = [...typescriptDiagnostics({ program }), ...result.diagnostics];
      return result;
    },
    fix: () => runEffects({ root, config, mode: 'fix', inputSnapshots: new Map() }),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
