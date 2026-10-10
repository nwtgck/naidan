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
const imports = "import { ref, shallowRef, watch, watchEffect, watchSyncEffect, watchPostEffect, onMounted, onUnmounted, onWatcherCleanup, onScopeDispose, customRef, type Ref } from './framework';";

export function vueFixture({ source, extra }: { source: string, extra: Readonly<Record<string, string>> }) {
  const fixture = createFixture({ files: { 'framework.d.ts': VUE_FIXTURE_DECLARATION, 'main.ts': `${imports}\n${source}`, ...extra }, entries: ['main.ts'] });
  fixture.config.vueModels = [{ file: 'framework.d.ts', sha256: digest({ content: VUE_FIXTURE_DECLARATION }) }];
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
