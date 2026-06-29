import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './no-xss-prone-browser-apis.js';

describe('no-xss-prone-browser-apis rule', () => {
  let eslint: ESLint;
  const repoRoot = path.resolve(__dirname, '..');

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
          'local-rules-xss-prone-browser-apis': {
            rules: {
              'no-xss-prone-browser-apis': rule,
            },
          },
        },
        rules: {
          'local-rules-xss-prone-browser-apis/no-xss-prone-browser-apis': 'error',
        },
      },
    });
  });

  async function lintText({
    code,
    filePath = 'src/components/Example.ts',
  }: {
    code: string,
    filePath?: string,
  }) {
    const [result] = await eslint.lintText(code, { filePath: path.resolve(repoRoot, filePath) });
    return result.messages;
  }

  it('completely bans document.write and document.writeln', async () => {
    const messages = await lintText({ code: `document.write(html); window.document.writeln(html);` });

    expect(messages.map(message => message.messageId)).toEqual(['noDocumentWrite', 'noDocumentWrite']);
  });

  it('bans eval-like APIs in Naidan-owned source', async () => {
    const messages = await lintText({ code: `eval(code); window.Function(code); new globalThis.Function(code);` });

    expect(messages.map(message => message.messageId)).toEqual(['noEvalLike', 'noEvalLike', 'noEvalLike']);
  });

  it('bans string-based timers but allows callback timers', async () => {
    const messages = await lintText({ code: `setTimeout("run()", 1); window.setInterval("tick()", 1); setTimeout(() => run(), 1);` });

    expect(messages.map(message => message.messageId)).toEqual(['noStringTimer', 'noStringTimer']);
  });

  it('bans raw HTML sinks', async () => {
    const messages = await lintText({
      code: `el.innerHTML = html; el.outerHTML = html; el.insertAdjacentHTML('beforeend', html); iframe.srcdoc = html; range.createContextualFragment(html);`,
    });

    expect(messages.map(message => message.messageId)).toEqual(['noHtmlSink', 'noHtmlSink', 'noHtmlSink', 'noHtmlSink', 'noHtmlSink']);
  });

  it('bans dangerous DOMParser HTML-like mime types case-insensitively but allows XML', async () => {
    const messages = await lintText({
      code: `parser.parseFromString(html, 'TEXT/HTML'); parser.parseFromString(xml, 'application/xml');`,
    });

    expect(messages.map(message => message.messageId)).toEqual(['noHtmlSink']);
  });

  it('bans script elements and event handler attributes case-insensitively', async () => {
    const messages = await lintText({
      code: `document.createElement('SCRIPT'); el.setAttribute('ONCLICK', code); el.setAttribute('SRCdoc', html);`,
    });

    expect(messages.map(message => message.messageId)).toEqual(['noScriptElement', 'noEventAttribute', 'noHtmlSink']);
  });

  it('allows static Vite worker URLs and bans dynamic worker-like APIs', async () => {
    const messages = await lintText({
      code: `new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' }); new Worker(url); new SharedWorker(url); importScripts(url); navigator.serviceWorker.register(url);`,
    });

    expect(messages.map(message => message.messageId)).toEqual(['noScriptLikeWorker', 'noScriptLikeWorker', 'noScriptLikeWorker', 'noScriptLikeWorker']);
  });

  it('allows explicit exception files', async () => {
    const messages = await lintText({
      filePath: 'src/features/file-protocol-standalone/worker/worker-hub-standalone-loader.ts',
      code: `new Worker(objectUrl, { name: 'standalone' });`,
    });

    expect(messages).toHaveLength(0);
  });
});
