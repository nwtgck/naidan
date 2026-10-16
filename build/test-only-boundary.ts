import type { Plugin } from 'vite';

/** Block test modules before tree shaking, including aliases and worker entries. */
export function createTestOnlyBoundaryPlugin(): Plugin {
  function assertRuntimeModule({ id }: { id: string }): void {
    const clean = id.replaceAll('\\', '/').split(/[?#]/u, 1)[0] ?? '';
    // The boundary owns Naidan code, not the internal filenames of dependencies.
    if (clean.includes('/node_modules/')) {
      return;
    }
    if (/(?:eslint-local-rules\/fixtures(?:\/|$)|\.test(?:\.|$)|\.spec(?:\.|$)|(?:^|[-/.])(?:test-support|test-helpers|test-utils|test-mocks|test-setup|test-tmp|lint-rule-tmp)(?:[/.]|$))/u.test(clean)) {
      throw new Error(`Test-only module reached a non-test bundle: ${id}`);
    }
  }

  return {
    name: 'naidan-test-only-boundary',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.replaceAll('\\', '/').includes('/node_modules/')) {
        assertRuntimeModule({ id: source });
      }
      return undefined;
    },
    load(id) {
      assertRuntimeModule({ id });
      return undefined;
    },
    transform(_code, id) {
      assertRuntimeModule({ id });
      return undefined;
    },
  };
}
