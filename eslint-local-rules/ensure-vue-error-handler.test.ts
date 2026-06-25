import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import * as parser from '@typescript-eslint/parser'
import { rule } from './ensure-vue-error-handler.js'

describe('ensure-vue-error-handler rule', () => {
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
          'local-rules-vue-error-handler': {
            rules: {
              'ensure-vue-error-handler': rule,
            },
          },
        },
        rules: {
          'local-rules-vue-error-handler/ensure-vue-error-handler': 'error',
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

  it('accepts a direct Vue error-handler assignment', async () => {
    expect(await lintText({
      code: 'app.config.errorHandler = (error, instance, info) => { console.error(error, instance, info) }',
    })).toHaveLength(0)
  })

  it('requires the direct assignment in main.ts', async () => {
    const messages = await lintText({ code: 'const app = createApp(App)' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('assign app.config.errorHandler directly')
  })
})
