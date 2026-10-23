// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createModuleGraph,
  inheritedAppSettingsEdge,
  inheritedLanguageSettingsEdge,
  isProductionModule,
  preservedOnboardingModule,
  preservedOnboardingReferences,
  staticEntryViolations,
  type ModuleGraph,
} from './entry-module-graph.test-support';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const heavyModule = 'src/features/llama-cpp-browser/hugging-face/metadata-session.ts';

function fixtureGraph({ entry, modules }: { entry: string, modules: Readonly<Record<string, string>> }): ModuleGraph {
  return createModuleGraph({
    sources: new Map([
      ['src/App.vue', entry],
      [heavyModule, 'export const metadata = {};'],
      [preservedOnboardingModule, '<script setup lang="ts">const preserved = true;</script><template><div /></template>'],
      ...Object.entries(modules),
    ]),
  });
}

describe('entry module graph analyzer', () => {
  it.each([
    { name: 'static import', entry: '<script setup lang="ts">import "@/features/llama-cpp-browser/hugging-face/metadata-session";</script>' },
    { name: 'named re-export', entry: '<script lang="ts">export { metadata } from "@/features/llama-cpp-browser/hugging-face/metadata-session";</script>' },
    { name: 'star re-export', entry: '<script lang="ts">export * from "@/features/llama-cpp-browser/hugging-face/metadata-session";</script>' },
    { name: 'eager glob', entry: '<script setup lang="ts">const modules = import.meta.glob("@/features/llama-cpp-browser/hugging-face/*.ts", { eager: true });</script>' },
    { name: 'external script', entry: '<script lang="ts" src="./features/llama-cpp-browser/hugging-face/metadata-session.ts"></script>' },
  ])('rejects heavy dependencies through $name', ({ entry }) => {
    const graph = fixtureGraph({ entry, modules: {} });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] })).toEqual([`src/App.vue -> ${heavyModule}`]);
  });

  it('follows aliases, extensionless imports, cycles and indirect barrel exports', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">import "~/facade";</script>',
      modules: {
        'src/facade/index.ts': 'import "../cycle"; export * from "../features/llama-cpp-browser/hugging-face/metadata-session";',
        'src/cycle.ts': 'import "./facade";',
      },
    });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] })).toEqual([`src/App.vue -> src/facade/index.ts -> ${heavyModule}`]);
  });

  it('finds a reused heavy presentation wrapper when inspecting the early entry chunk itself', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">const load = () => import("@/components/AppEntrySurface.vue");</script>',
      modules: {
        'src/components/AppEntrySurface.vue': '<script setup lang="ts">import "./LinkedPreview.vue";</script>',
        'src/components/LinkedPreview.vue': '<script setup lang="ts">import "./SharedWelcome.vue";</script>',
        'src/components/SharedWelcome.vue': `<script setup lang="ts">import '/${heavyModule}';</script>`,
      },
    });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] })).toEqual([]);
    expect(staticEntryViolations({ graph, root: 'src/components/AppEntrySurface.vue', boundaryEdges: [] }))
      .toEqual([`src/components/AppEntrySurface.vue -> src/components/LinkedPreview.vue -> src/components/SharedWelcome.vue -> ${heavyModule}`]);
  });

  it('allows deferred runtime imports and type-only edges in the synchronous graph', () => {
    const graph = fixtureGraph({
      entry: `\
<script setup lang="ts">
import type { Metadata } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { type OtherMetadata } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
const load = () => import('@/features/llama-cpp-browser/hugging-face/metadata-session');
const deferred = import.meta.glob('@/features/llama-cpp-browser/hugging-face/*.ts');
</script>`,
      modules: {},
    });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] })).toEqual([]);
    expect(graph.referencesFrom({ from: 'src/App.vue' }).map(reference => reference.kind)).toEqual(['type', 'type', 'dynamic', 'dynamic']);
  });

  it.each([
    'import "@/components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue";',
    'export * from "@/components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue";',
    'const load = () => import("@/components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue");',
    'const load = () => import("@/components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue?raw");',
    'const load = () => import("@/components/OnboardingModalWhichMustBePreservedForFutureReference" + "AndMustNeverBeUsedInProduction.vue");',
    'export const modules = import.meta.glob("@/components/*.vue");',
    'export const modules = import.meta.glob(["@/components/*.vue"], { eager: true });',
    'import type Preserved from "@/components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue";',
  ])('rejects preserved onboarding in any production source: %s', script => {
    const graph = fixtureGraph({ entry: '<script setup lang="ts">const light = true;</script>', modules: { 'src/unreachable.ts': script } });
    expect(preservedOnboardingReferences({ graph })).toHaveLength(1);
    expect(preservedOnboardingReferences({ graph })[0]?.from).toBe('src/unreachable.ts');
  });

  it('checks preserved onboarding behind a dynamically loaded barrel', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">const load = () => import("./deferred");</script>',
      modules: { 'src/deferred.ts': `export { default } from '/${preservedOnboardingModule}';` },
    });
    expect(preservedOnboardingReferences({ graph })).toEqual([{ from: 'src/deferred.ts', target: preservedOnboardingModule, kind: 'static' }]);
  });

  it('allows dedicated tests and respects glob exclusions without interpreting comments as imports', () => {
    const graph = fixtureGraph({
      entry: `\
<script setup lang="ts">
// import Preserved from '/${preservedOnboardingModule}';
const modules = import.meta.glob(['@/components/*.vue', '!@/components/OnboardingModal*.vue']);
</script>`,
      modules: { 'src/components/OnboardingModal.test.ts': `import Preserved from '/${preservedOnboardingModule}';` },
    });
    expect(preservedOnboardingReferences({ graph })).toEqual([]);
  });

  it('normalizes alias paths before checking preserved onboarding', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">const light = true;</script>',
      modules: { 'src/deferred.ts': 'const load = () => import("@/components/../components/OnboardingModalWhichMustBePreservedForFutureReferenceAndMustNeverBeUsedInProduction.vue");' },
    });
    expect(preservedOnboardingReferences({ graph })).toHaveLength(1);
  });

  it('treats ordinary static assets as graph terminals and reports missing code modules', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">import logo from "@/assets/logo.svg"; import "@/missing";</script>',
      modules: {},
    });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] }))
      .toEqual(['Unresolved source module: src/App.vue -> src/missing']);
  });

  it('traverses local input adapters instead of exempting their dependency graphs', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">import "@/features/llama-cpp-browser/runtime/directory-input";</script>',
      modules: { 'src/features/llama-cpp-browser/runtime/directory-input.ts': `export * from '/${heavyModule}';` },
    });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] }))
      .toEqual([`src/App.vue -> src/features/llama-cpp-browser/runtime/directory-input.ts -> ${heavyModule}`]);
  });

  it.each([
    'import "@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue";',
    'import "@/features/llama-cpp-browser/components/LlamaCppBrowserModelLibrary.vue";',
    'import "@/components/ChatPane.vue";',
    'import "llama-cpp-browser-core";',
    'import "@huggingface/transformers";',
    'import nativeRuntime from "/inference/engine.wasm?url";',
    'new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });',
    'import "./worker.ts?worker";',
  ])('rejects manager, library, chat, worker and native runtime edges: %s', script => {
    const graph = fixtureGraph({ entry: `<script setup lang="ts">${script}</script>`, modules: { 'src/worker.ts': 'export const worker = true;' } });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [] }).length).toBeGreaterThan(0);
  });

  it('limits the inherited settings exception to its exact edge', () => {
    const graph = fixtureGraph({
      entry: '<script setup lang="ts">import "@/composables/useAppEntry"; import "@/other";</script>',
      modules: {
        'src/composables/useAppEntry.ts': 'import "./useSettings";',
        'src/composables/useSettings.ts': `import '/${heavyModule}';`,
        'src/other.ts': 'import "@/composables/useSettings";',
      },
    });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [inheritedAppSettingsEdge] }))
      .toEqual([`src/App.vue -> src/other.ts -> src/composables/useSettings.ts -> ${heavyModule}`]);
  });
});

describe('production entry module boundaries', () => {
  let graph: ModuleGraph;

  beforeAll(() => {
    const sources = new Map<string, string>();
    for (const entry of fs.readdirSync(path.join(projectRoot, 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const filename = path.relative(projectRoot, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/');
      if (isProductionModule({ filename })) {
        sources.set(filename, fs.readFileSync(path.join(projectRoot, filename), 'utf8'));
      }
    }
    graph = createModuleGraph({ sources });
  }, 30000);

  it('keeps preserved onboarding unreachable from every production module, including lazy imports and globs', () => {
    expect(graph.sources.has(preservedOnboardingModule)).toBe(true);
    expect(preservedOnboardingReferences({ graph })).toEqual([]);
  }, 30000);

  it('synchronously owns the model dialog, its shell and its model cards before MainApp is imported', () => {
    for (const [from, target] of [
      ['src/App.vue', 'src/components/BrowserModelWelcomeDialog.vue'],
      ['src/components/BrowserModelWelcomeDialog.vue', 'src/components/BrowserModelDialog.vue'],
      ['src/components/BrowserModelWelcomeDialog.vue', 'src/components/BrowserModelWelcome.vue'],
    ]) {
      expect(graph.referencesFrom({ from: from! })).toContainEqual({ from, target, kind: 'static' });
    }
    expect(graph.referencesFrom({ from: 'src/components/BrowserModelWelcomeDialog.vue' })).toContainEqual({ from: 'src/components/BrowserModelWelcomeDialog.vue', target: 'src/components/BrowserModelFileSelection.vue', kind: 'dynamic' });
    expect(graph.referencesFrom({ from: 'src/components/BrowserModelWelcomeDialog.vue' })).toContainEqual({ from: 'src/components/BrowserModelWelcomeDialog.vue', target: 'src/components/BrowserConnectionSelection.vue', kind: 'dynamic' });
    expect(graph.referencesFrom({ from: 'src/components/BrowserModelWelcomeDialog.vue' })).not.toContainEqual({ from: 'src/components/BrowserModelWelcomeDialog.vue', target: 'src/components/BrowserConnectionSelection.vue', kind: 'static' });
  });

  it('keeps App synchronous dependencies lightweight across the existing settings boundary', () => {
    // App's entry controller and the reused language menu share the inherited
    // settings owner and its synchronous service facades. Exempt these exact
    // edges, never a new direct settings import from an entry component.
    expect(graph.referencesFrom({ from: inheritedAppSettingsEdge.from }))
      .toContainEqual({ ...inheritedAppSettingsEdge, kind: 'static' });
    expect(graph.referencesFrom({ from: inheritedLanguageSettingsEdge.from }))
      .toContainEqual({ ...inheritedLanguageSettingsEdge, kind: 'static' });
    expect(staticEntryViolations({ graph, root: 'src/App.vue', boundaryEdges: [inheritedAppSettingsEdge, inheritedLanguageSettingsEdge] })).toEqual([]);
  });

  it.each([
    'src/components/BrowserModelWelcome.vue',
    'src/components/ModelDiscoveryPanel.vue',
  ])('keeps %s independent of synchronous HF sessions, libraries, workers and runtimes', root => {
    expect(graph.sources.has(root), `Required production entry is missing: ${root}`).toBe(true);
    expect(staticEntryViolations({ graph, root, boundaryEdges: [inheritedLanguageSettingsEdge] })).toEqual([]);
  });

  it.each([
    'src/components/AppEntrySurface.vue',
    'src/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue',
  ])('keeps the early entry presentation %s lightweight across the existing controller boundary', root => {
    expect(graph.sources.has(root), `Required early entry is missing: ${root}`).toBe(true);
    expect(staticEntryViolations({ graph, root, boundaryEdges: [inheritedAppSettingsEdge, inheritedLanguageSettingsEdge] })).toEqual([]);
  });

  it('shares a layout-only welcome frame without a settings exception', () => {
    const target = 'src/components/layout/WelcomeScreenFrame.vue';
    expect(graph.sources.has(target)).toBe(true);
    for (const from of ['src/components/WelcomeScreen.vue', 'src/components/BrowserModelWelcome.vue', 'src/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue']) {
      expect(graph.referencesFrom({ from })).toContainEqual({ from, target, kind: 'static' });
    }
    expect(staticEntryViolations({ graph, root: target, boundaryEdges: [] })).toEqual([]);
  });

  it('keeps the shared model entry state independent of services and runtime implementations', () => {
    expect(staticEntryViolations({ graph, root: 'src/features/llama-cpp-browser/model-launch/entry-state.ts', boundaryEdges: [] })).toEqual([]);
  });
});
