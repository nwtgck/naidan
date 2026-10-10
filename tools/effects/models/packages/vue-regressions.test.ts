import { describe, expect, it } from 'vitest';
import { createFixture } from '../../test-support/project-fixture.ts';
import { digest } from '../../project.ts';

const declaration = `\
export interface Ref<T> { get value(): T; set value(value: T); }
export interface WatchHandle { (): void; stop(): void; pause(): void; resume(): void; }
export declare function ref<T>(value: T): Ref<T>;
export declare function watch<T>(source: Ref<T>, callback: (value: T) => void): WatchHandle;
`;

describe('Vue contract replacement adversaries', () => {
  it('rejects replacing a watch handle while an earlier alias still uses its old lifetime bound', () => {
    const fixture = createFixture({
      files: {
        'framework.d.ts': declaration,
        'main.ts': `\
import { ref, watch } from './framework';
const name = ref('');
let handle = watch(name, () => {});
function replace() { handle = watch(name, () => { localStorage.clear(); }); }
function stop() { handle(); }
`,
      },
      entries: ['main.ts'],
    });
    fixture.config.vueModels = [{ file: 'framework.d.ts', sha256: digest({ content: declaration }) }];
    try {
      const result = fixture.check();
      expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.startsWith('Replacing a Vue watch handle'))).toBe(true);
      expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.startsWith('Runtime import initialization'))).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });
});
