import fs from 'node:fs';
import path from 'node:path';
import { createFixture } from './project-fixture.ts';
import { digest } from '../project.ts';

export const VUE_FIXTURE_DECLARATION = `\
export interface Ref<T> { get value(): T; set value(value: T); }
export interface WatchHandle { (): void; stop(): void; pause(): void; resume(): void; }
export interface WatchOptions { immediate?: boolean; flush?: 'pre' | 'post' | 'sync'; deep?: boolean | number; once?: boolean; onTrigger?: () => void; }
export declare function ref<T>(value: T): Ref<T>;
export declare function shallowRef<T>(value: T): Ref<T>;
export declare function watch<T>(source: Ref<T> | (() => T), callback: (value: T, old: T | undefined, onCleanup: (cleanup: () => void) => void) => void, options?: WatchOptions): WatchHandle;
export declare function watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void, options?: WatchOptions): WatchHandle;
export declare const watchSyncEffect: typeof watchEffect;
export declare const watchPostEffect: typeof watchEffect;
export declare function onMounted(callback: () => void): void;
export declare function onUnmounted(callback: () => void): void;
export declare function onScopeDispose(callback: () => void): void;
export declare function onWatcherCleanup(callback: () => void): void;
export declare function customRef<T>(factory: () => { get: () => T; set: (value: T) => void }): Ref<T>;
`;
const globalDeclaration = VUE_FIXTURE_DECLARATION.replaceAll('export ', '');

export function vueFixture({ source, extra }: { source: string, extra: Readonly<Record<string, string>> }) {
  // Model-only cases use reviewed ambient globals, so they do not assert that a
  // package import has an empty initializer. Explicit import cases retain the
  // exported declaration and must report that separate unknown boundary.
  const fixture = createFixture({ files: { 'framework.d.ts': VUE_FIXTURE_DECLARATION, 'framework-global.d.ts': globalDeclaration, 'main.ts': source + '\nexport {};', ...extra }, entries: ['main.ts'] });
  const config = path.join(fixture.root, 'tsconfig.json');
  const value = JSON.parse(fs.readFileSync(config, 'utf8')) as { files: string[] };
  value.files.push('framework-global.d.ts');
  fs.writeFileSync(config, JSON.stringify(value));
  fixture.config.vueModels = [
    { file: 'framework.d.ts', sha256: digest({ content: VUE_FIXTURE_DECLARATION }) },
    { file: 'framework-global.d.ts', sha256: digest({ content: globalDeclaration }) },
  ];
  return fixture;
}

export function checkVueSource({ source }: { source: string }) {
  const fixture = vueFixture({ source, extra: {} });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}
