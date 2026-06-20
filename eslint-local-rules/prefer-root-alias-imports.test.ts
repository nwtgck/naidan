import { describe, it, expect, beforeAll } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import * as tsParser from '@typescript-eslint/parser'
import { rule } from './prefer-root-alias-imports.js'

describe('prefer-root-alias-imports rule', () => {
  let eslint: ESLint
  let eslintFix: ESLint
  const repoRoot = path.resolve(__dirname, '..')

  beforeAll(() => {
    const baseOptions = {
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules-imports': {
            rules: {
              'prefer-root-alias-imports': rule,
            },
          },
        },
        rules: {
          'local-rules-imports/prefer-root-alias-imports': [
            'error',
            { rootDir: 'src', aliasPrefix: '@' },
          ],
        },
      },
    } satisfies ConstructorParameters<typeof ESLint>[0]

    eslint = new ESLint(baseOptions)
    eslintFix = new ESLint({ ...baseOptions, fix: true })
  })

  async function lintText({
    code,
    filePath = 'src/components/Example.ts',
    fix = false,
  }: {
    code: string
    filePath?: string
    fix?: boolean
  }) {
    const runner = fix ? eslintFix : eslint
    const [result] = await runner.lintText(code, { filePath: path.resolve(repoRoot, filePath) })
    return result
  }

  async function expectFixed({
    code,
    output,
    filePath,
  }: {
    code: string
    output: string
    filePath?: string
  }) {
    const reportResult = await lintText({ code, filePath })
    expect(reportResult.messages).toHaveLength(1)
    expect(reportResult.messages[0]?.messageId).toBe('preferRootAliasImport')

    const fixResult = await lintText({ code, filePath, fix: true })
    expect(fixResult.output).toBe(output)
  }

  it('allows same-folder relative imports', async () => {
    const result = await lintText({ code: `import Foo from './Foo'` })

    expect(result.messages).toHaveLength(0)
    expect(result.output).toBeUndefined()
  })

  it('allows root alias imports', async () => {
    const result = await lintText({ code: `import { storageService } from '@/services/storage'` })

    expect(result.messages).toHaveLength(0)
    expect(result.output).toBeUndefined()
  })

  it('allows package imports', async () => {
    const result = await lintText({ code: `import { ref } from 'vue'` })

    expect(result.messages).toHaveLength(0)
    expect(result.output).toBeUndefined()
  })

  it('fixes parent-folder imports to root alias imports', async () => {
    await expectFixed({
      code: `import { storageService } from '../services/storage'`,
      output: `import { storageService } from '@/services/storage'`,
    })
  })

  it('fixes nested parent-folder imports to root alias imports', async () => {
    await expectFixed({
      filePath: 'src/components/block-markdown/GeneratedImageBlock.test.ts',
      code: `import { MESSAGE_CONTEXTUAL_PREVIEW_KEY } from '../../composables/useImagePreview'`,
      output: `import { MESSAGE_CONTEXTUAL_PREVIEW_KEY } from '@/composables/useImagePreview'`,
    })
  })

  it('fixes re-exports', async () => {
    await expectFixed({
      code: `export { createStorage } from '../services/storage'`,
      output: `export { createStorage } from '@/services/storage'`,
    })
  })

  it('fixes export-all declarations', async () => {
    await expectFixed({
      code: `export * from '../services/storage'`,
      output: `export * from '@/services/storage'`,
    })
  })

  it('fixes dynamic imports', async () => {
    await expectFixed({
      code: `const mod = await import('../services/storage')`,
      output: `const mod = await import('@/services/storage')`,
    })
  })

  it('fixes TS import types', async () => {
    await expectFixed({
      code: `type Attachment = import('../models/types').Attachment`,
      output: `type Attachment = import('@/models/types').Attachment`,
    })
  })

  it('keeps query suffixes', async () => {
    await expectFixed({
      code: `const raw = await import('../assets/example.txt?raw')`,
      output: `const raw = await import('@/assets/example.txt?raw')`,
    })
  })

  it('does not fix imports from files outside rootDir', async () => {
    const result = await lintText({
      filePath: 'eslint-local-rules/example.ts',
      code: `import { helper } from '../src/utils/helper'`,
    })

    expect(result.messages).toHaveLength(0)
    expect(result.output).toBeUndefined()
  })

  it('does not fix imports that resolve outside rootDir', async () => {
    const result = await lintText({
      filePath: 'src/services/wesh/naidan-sysfs/constants.ts',
      code: `import packageJson from '../../../../package.json'`,
    })

    expect(result.messages).toHaveLength(0)
    expect(result.output).toBeUndefined()
  })
})
