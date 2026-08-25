import { describe, expect, it } from 'vitest';

import {
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';
import { assertFileProtocolStandaloneHtmlAfterRewrite } from './html-validation.js';
import { insertFileProtocolStandaloneBootstrap } from './html-output.js';

function generatedScripts(): string {
  return FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS.map((id, index) => (
    index < 3
      ? `<script id="${id}" src="./file-protocol-standalone/runtime-${index}.js"></script>`
      : `<script id="${id}">globalThis.started = true</script>`
  )).join('');
}

describe('insertFileProtocolStandaloneBootstrap', () => {
  it('keeps the normal explicit-head output path minimal', () => {
    const bootstrap = generatedScripts();
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>';

    expect(insertFileProtocolStandaloneBootstrap({ html, bootstrap })).toBe(
      `<!doctype html><html><head><meta charset="utf-8">${bootstrap}</head><body><div id="app"></div></body></html>`,
    );
  });

  it('uses the parsed head boundary instead of a </head> token inside a comment', () => {
    const bootstrap = generatedScripts();
    const html = '<!doctype html><html><head><!-- literal </head> token --><meta charset="utf-8"></head><body></body></html>';

    const rewritten = insertFileProtocolStandaloneBootstrap({ html, bootstrap });

    expect(rewritten).toContain('<!-- literal </head> token -->');
    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({
      html: rewritten,
      htmlFileName: 'index.html',
    })).not.toThrow();
  });

  it('does not mistake </head> text inside an allowed pre-runtime script for the head boundary', () => {
    const bootstrap = generatedScripts();
    const preRuntime = `<script id="theme-init" ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}">globalThis.marker = "</head>";</script>`;
    const html = `<!doctype html><html><head>${preRuntime}<meta charset="utf-8"></head><body></body></html>`;

    const rewritten = insertFileProtocolStandaloneBootstrap({ html, bootstrap });

    expect(rewritten).toContain(preRuntime);
    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({
      html: rewritten,
      htmlFileName: 'index.html',
    })).not.toThrow();
  });

  it('injects into the parser-created head when valid HTML omits an explicit head', () => {
    const bootstrap = generatedScripts();
    const inputs = [
      '<!doctype html><html><body><div id="app"></div></body></html>',
      '<div id="app"></div>',
    ];

    for (const html of inputs) {
      const rewritten = insertFileProtocolStandaloneBootstrap({ html, bootstrap });

      expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({
        html: rewritten,
        htmlFileName: 'index.html',
      })).not.toThrow();
      expect(FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS.every(id => rewritten.includes(`id="${id}"`))).toBe(true);
    }
  });
});
