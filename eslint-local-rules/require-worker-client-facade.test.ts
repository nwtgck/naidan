import { describe, it, expect, beforeAll } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import { rule } from './require-worker-client-facade.js'
import * as parser from '@typescript-eslint/parser'

describe('require-worker-client-facade rule', () => {
  let eslint: ESLint
  const repoRoot = path.resolve(__dirname, '..')

  beforeAll(() => {
    eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          parserOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
          },
        },
        plugins: {
          'local-rules-worker-facade': {
            rules: {
              'require-worker-client-facade': rule,
            },
          },
        },
        rules: {
          'local-rules-worker-facade/require-worker-client-facade': 'error',
        },
      },
    })
  })

  async function lintText({
    code,
    filePath,
  }: {
    code: string
    filePath: string
  }) {
    const [result] = await eslint.lintText(code, { filePath })
    return result.messages
  }

  it('reports relative worker client imports from non-facade runtime files', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/services/highlight/worker/temp-client-shared.ts'),
      code: `import { createHighlightWorkerClient } from './client'`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe('local-rules-worker-facade/require-worker-client-facade')
    expect(messages[0]?.message).toContain('@/services/highlight/worker/client')
  })

  it('reports direct hosted client alias imports', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/components/TempWorkerClientConsumer.ts'),
      code: `import { createHighlightWorkerClient } from '@/services/highlight/worker/client-hosted'`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('@/services/highlight/worker/client')
  })

  it('allows facade files to re-export client-hosted', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/services/highlight/worker/client.ts'),
      code: `export { createHighlightWorkerClient } from './client-hosted'`,
    })

    expect(messages).toHaveLength(0)
  })

  it('allows tests to import implementation files directly', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/services/highlight/worker/client-hosted.test.ts'),
      code: `import { createHighlightWorkerClient } from './client-hosted'`,
    })

    expect(messages).toHaveLength(0)
  })

  it('reports relative imports that resolve to worker implementations across directories', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/services/highlight/helpers/shared.ts'),
      code: `import { createHighlightWorkerClient } from '../worker/client-standalone'`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('@/services/highlight/worker/client')
  })

  it('reports nested worker implementation imports with the nested facade path', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/services/transformers-js/scanner/worker/client-shared.ts'),
      code: `import { createTransformersJsScannerWorkerClient } from './client-standalone'`,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('@/services/transformers-js/scanner/worker/client')
  })

  it('ignores non-standalone worker-shaped imports outside the shared facade list', async () => {
    const messages = await lintText({
      filePath: path.resolve(repoRoot, 'src/services/example/worker/client-shared.ts'),
      code: `import { createExampleWorkerClient } from './client'`,
    })

    expect(messages).toHaveLength(0)
  })
})
