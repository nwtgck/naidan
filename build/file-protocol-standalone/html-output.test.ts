import { describe, expect, it } from 'vitest';

import {
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
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
