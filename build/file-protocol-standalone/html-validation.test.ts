import { describe, expect, it } from 'vitest';

import {
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';
import {
  assertFileProtocolStandaloneHtmlAfterRewrite,
  assertFileProtocolStandaloneHtmlBeforeRewrite,
  resolveFileProtocolStandaloneHtmlReference,
} from './html-validation.js';

function preRuntimeScript(): string {
  return `<script id="initial-theme" ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}">globalThis.theme = true</script>`;
}

function generatedScripts(): string {
  return FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS.map((id, index) => (
    index < 3
      ? `<script id="${id}" src="./file-protocol-standalone/runtime-${index}.js"></script>`
      : `<script id="${id}">globalThis.started = true</script>`
  )).join('');
}

describe('file protocol standalone HTML validation', () => {
  it('accepts one Vite entry, an inline pre-runtime script, and local stylesheets before rewrite', () => {
    const html = `<!doctype html><html><head>${preRuntimeScript()}<link rel="stylesheet" crossorigin href="./assets/index.css"></head><body><script type="module" crossorigin src="./assets/index.js"></script></body></html>`;

    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' })).not.toThrow();
  });

  it('rejects unexpected executable scripts and preload links before rewrite', () => {
    const extraScript = `<!doctype html><html><head></head><body><script src="./unexpected.js"></script><script type="module" src="./assets/index.js"></script></body></html>`;
    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html: extraScript, htmlFileName: 'index.html' }))
      .toThrow('Expected exactly one Vite application entry script; found 2');

    const preload = `<!doctype html><html><head><link rel="modulepreload" href="./assets/lazy.js"></head><body><script type="module" src="./assets/index.js"></script></body></html>`;
    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html: preload, htmlFileName: 'index.html' }))
      .toThrow('must not contain preload links');
  });

  it('rejects network-dependent stylesheets before rewrite', () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" href="https://example.com/index.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>';

    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' }))
      .toThrow('stylesheet href must identify one local output file');
  });

  it('rejects reserved ids and invalid pre-runtime placement before rewrite', () => {
    const reserved = `<!doctype html><html><head><div id="${FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS[0]}"></div></head><body><script type="module" src="./assets/index.js"></script></body></html>`;
    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html: reserved, htmlFileName: 'index.html' }))
      .toThrow('already contains reserved standalone element id');

    const bodyPreRuntime = `<!doctype html><html><head></head><body>${preRuntimeScript()}<script type="module" src="./assets/index.js"></script></body></html>`;
    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html: bodyPreRuntime, htmlFileName: 'index.html' }))
      .toThrow('must be in <head>');
  });

  it('resolves normalized local references while rejecting network and ambiguous output URLs', () => {
    expect(resolveFileProtocolStandaloneHtmlReference({
      reference: '../assets/index.js',
      htmlFileName: 'nested/index.html',
      attribute: 'script src',
    })).toBe('assets/index.js');

    for (const reference of ['https://example.com/a.js', './a.js?x=1', './a.js#x', './assets%2Fsecret.js', '.\\assets\\index.js']) {
      expect(() => resolveFileProtocolStandaloneHtmlReference({
        reference,
        htmlFileName: 'index.html',
        attribute: 'script src',
      })).toThrow();
    }
  });

  it('accepts only the generated runtime sequence after rewrite', () => {
    const html = `<!doctype html><html><head>${preRuntimeScript()}<link rel="stylesheet" href="./assets/index.css">${generatedScripts()}</head><body></body></html>`;

    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({ html, htmlFileName: 'index.html' })).not.toThrow();
  });

  it('rejects reordered or crossorigin generated scripts after rewrite', () => {
    const scripts = generatedScripts();
    const reordered = scripts.replace(
      `<script id="${FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS[0]}"`,
      `<script id="unexpected"`,
    );
    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({
      html: `<!doctype html><html><head>${reordered}</head><body></body></html>`,
      htmlFileName: 'index.html',
    })).toThrow('Final executable script order is invalid');

    const crossorigin = scripts.replace('<script ', '<script crossorigin ');
    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({
      html: `<!doctype html><html><head>${crossorigin}</head><body></body></html>`,
      htmlFileName: 'index.html',
    })).toThrow('still has crossorigin');
  });
});
