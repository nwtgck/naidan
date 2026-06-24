import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import * as parser from '@typescript-eslint/parser'
import { rule } from './ensure-debug-vue-error-handler.js'

describe('ensure-debug-vue-error-handler rule', () => {
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
          'local-rules-debug-vue-error-handler': {
            rules: {
              'ensure-debug-vue-error-handler': rule,
            },
          },
        },
        rules: {
          'local-rules-debug-vue-error-handler/ensure-debug-vue-error-handler': 'error',
        },
      },
    })
  })

  async function lintText({ code }: { code: string }) {
    const [result] = await eslint.lintText(code, {
      filePath: path.resolve(repoRoot, 'src/main.ts'),
    })
    return result.messages
  }

  it('accepts the explicit Debug installer boundary', async () => {
    expect(await lintText({ code: 'debugInstallVueErrorHandler({ app })' })).toHaveLength(0)
  })

  it('rejects a direct Vue error-handler assignment', async () => {
    const messages = await lintText({
      code: `\
app.config.errorHandler = () => {}
debugInstallVueErrorHandler({ app })`,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('must not assign app.config.errorHandler directly')
  })

  it('requires the named Debug installer', async () => {
    const messages = await lintText({ code: 'const app = createApp(App)' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('debugInstallVueErrorHandler')
  })
})
