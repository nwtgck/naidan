import { describe, it, expect, beforeAll } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import * as parser from 'vue-eslint-parser'
import * as tsParser from '@typescript-eslint/parser'
import { rule } from './no-raw-v-html.js'

describe('no-raw-v-html rule', () => {
  let eslint: ESLint
  const repoRoot = path.resolve(__dirname, '..')

  beforeAll(() => {
    eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.vue'],
        languageOptions: {
          parser,
          parserOptions: {
            parser: tsParser,
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules-allowed-html': {
            rules: {
              'no-raw-v-html': rule,
            },
          },
        },
        rules: {
          'local-rules-allowed-html/no-raw-v-html': 'error',
        },
      },
    })
  })

  async function lintText({
    code,
    filePath = 'src/components/Example.vue',
  }: {
    code: string
    filePath?: string
  }) {
    const [result] = await eslint.lintText(code, { filePath: path.resolve(repoRoot, filePath) })
    return result.messages
  }

  it('reports v-html outside AllowedHtmlView', async () => {
    const messages = await lintText({ code: `<template><div v-html="html" /></template>` })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.messageId).toBe('noRawVHtml')
  })

  it('allows v-html in AllowedHtmlView.vue', async () => {
    const messages = await lintText({
      filePath: 'src/components/common/AllowedHtmlView.vue',
      code: `<template><component :is="as" v-html="html" /></template>`,
    })

    expect(messages).toHaveLength(0)
  })
})
