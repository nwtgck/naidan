import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import vuePlugin from '@vitejs/plugin-vue';
import { build, type PluginOption, type Rollup } from 'vite';
import fs from 'fs';
import path from 'path';

function getOutputChunks({ result }: {
  result: Rollup.RollupOutput | Rollup.RollupOutput[],
}): Rollup.OutputChunk[] {
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) => (
    output.output.filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
  ));
}

async function buildJavascript({
  entry,
  isTest,
  plugins,
}: {
  entry: string,
  isTest: boolean,
  plugins: PluginOption[],
}): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins,
    define: {
      __BUILD_MODE_IS_TEST__: JSON.stringify(isTest),
    },
    build: {
      write: false,
      minify: false,
      lib: {
        entry,
        formats: ['es'],
      },
    },
  });

  return getOutputChunks({ result })
    .map((chunk) => chunk.code)
    .join('\n');
}

describe('TEST_ONLY production bundling', () => {
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const suffix = Math.random().toString(36).slice(2);
  const componentPath = path.resolve(testFileDir, `test-only-component-${suffix}.vue`);
  const entryPath = path.resolve(testFileDir, `test-only-bundle-${suffix}.ts`);
  const modulePath = path.resolve(testFileDir, `test-only-module-${suffix}.ts`);
  const runtimePath = path.resolve(testFileDir, `test-only-runtime-${suffix}.ts`);

  beforeAll(() => {
    fs.mkdirSync(testFileDir, { recursive: true });
    fs.writeFileSync(componentPath, `
      <script setup lang="ts">
      const productionText = 'VUE_PRODUCTION_SENTINEL_VALUE';

      defineExpose({
        ...((__BUILD_MODE_IS_TEST__ && {
          TEST_ONLY: {
            sentinel: (function vueTestOnlySentinelFunction(): string {
              return 'VUE_TEST_ONLY_SENTINEL_VALUE';
            })(),
          },
        }) || {}),
      });
      </script>

      <template>
        <div>{{ productionText }}</div>
      </template>
    `);

    fs.writeFileSync(modulePath, `
      function moduleTestOnlySentinelFunction(): string {
        return 'MODULE_TEST_ONLY_SENTINEL_VALUE';
      }

      export function readModuleProductionValue(): string {
        return 'MODULE_PRODUCTION_SENTINEL_VALUE';
      }

      export const TEST_ONLY = {
        sentinel: moduleTestOnlySentinelFunction,
      };    `);

    fs.writeFileSync(entryPath, `
      import TestOnlyComponent from './${path.basename(componentPath)}';
      import * as testOnlyModule from './${path.basename(modulePath)}';

      function childTestOnlySentinelFunction(): string {
        return 'CHILD_TEST_ONLY_SENTINEL_VALUE';
      }

      function createChildValue() {
        return {
          value: 'CHILD_PRODUCTION_SENTINEL_VALUE',
          ...((__BUILD_MODE_IS_TEST__ && {
            TEST_ONLY: {
              sentinel: childTestOnlySentinelFunction(),
            },
          }) || {}),
        };
      }

      function parentTestOnlySentinelFunction(): string {
        return 'PARENT_TEST_ONLY_SENTINEL_VALUE';
      }

      export function createProductionValue() {
        const child = createChildValue();

        return {
          component: TestOnlyComponent,
          value: [
            'PRODUCTION_SENTINEL_VALUE',
            child.value,
            testOnlyModule.readModuleProductionValue(),
          ].join(':'),
          ...((__BUILD_MODE_IS_TEST__ && {
            TEST_ONLY: {
              childSentinel: child.TEST_ONLY.sentinel,
              parentSentinel: parentTestOnlySentinelFunction(),
            },
          }) || {}),
        };
      }
    `);

    fs.writeFileSync(runtimePath, `
      export function createTestValue() {
        return {
          ...((__BUILD_MODE_IS_TEST__ && {
            TEST_ONLY: {
              read: () => 'RUNTIME_OBJECT_TEST_ONLY_SENTINEL_VALUE',
            },
          }) || {}),
        };
      }

      export const TEST_ONLY = {
        read: () => 'RUNTIME_EXPORT_TEST_ONLY_SENTINEL_VALUE',
      };    `);
  });

  afterAll(() => {
    fs.rmSync(componentPath, { force: true });
    fs.rmSync(entryPath, { force: true });
    fs.rmSync(modulePath, { force: true });
    fs.rmSync(runtimePath, { force: true });
  });

  it('removes object, nested, Vue, and module test APIs from a production bundle', async () => {
    const javascript = await buildJavascript({
      entry: entryPath,
      isTest: false,
      plugins: [vuePlugin()],
    });

    expect(javascript).toContain('PRODUCTION_SENTINEL_VALUE');
    expect(javascript).toContain('CHILD_PRODUCTION_SENTINEL_VALUE');
    expect(javascript).toContain('MODULE_PRODUCTION_SENTINEL_VALUE');
    expect(javascript).toContain('VUE_PRODUCTION_SENTINEL_VALUE');

    expect(javascript).not.toContain('TEST_ONLY');
    expect(javascript).not.toContain('childTestOnlySentinelFunction');
    expect(javascript).not.toContain('CHILD_TEST_ONLY_SENTINEL_VALUE');
    expect(javascript).not.toContain('parentTestOnlySentinelFunction');
    expect(javascript).not.toContain('PARENT_TEST_ONLY_SENTINEL_VALUE');
    expect(javascript).not.toContain('moduleTestOnlySentinelFunction');
    expect(javascript).not.toContain('MODULE_TEST_ONLY_SENTINEL_VALUE');
    expect(javascript).not.toContain('vueTestOnlySentinelFunction');
    expect(javascript).not.toContain('VUE_TEST_ONLY_SENTINEL_VALUE');
  });

  it('keeps direct TEST_ONLY access functional in a test build', async () => {
    const javascript = await buildJavascript({
      entry: runtimePath,
      isTest: true,
      plugins: [],
    });
    const encodedJavascript = Buffer.from(javascript).toString('base64');
    const moduleNamespace = await import(`data:text/javascript;base64,${encodedJavascript}`) as {
      createTestValue: () => {
        TEST_ONLY: {
          read: () => string,
        },
      },
      TEST_ONLY: {
        read: () => string,
      },
    };

    expect(moduleNamespace.createTestValue().TEST_ONLY.read())
      .toBe('RUNTIME_OBJECT_TEST_ONLY_SENTINEL_VALUE');
    expect(moduleNamespace.TEST_ONLY.read())
      .toBe('RUNTIME_EXPORT_TEST_ONLY_SENTINEL_VALUE');
  });
});
