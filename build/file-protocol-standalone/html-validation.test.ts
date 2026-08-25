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

  it('returns normalized stylesheet outputs and application entry location from parsed HTML before rewrite', () => {
    const html = '<!doctype html><html><head><link rel=stylesheet href=./assets/index.css></head><body><script crossorigin src=./assets/index.js type=module></script></body></html>';

    const result = assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' });
    expect(result.stylesheetReferences.map(({ fileName }) => fileName)).toEqual(['assets/index.css']);
    expect(result.applicationEntry.source).toBe('./assets/index.js');
    expect(html.slice(result.applicationEntry.startOffset, result.applicationEntry.endOffset))
      .toBe('<script crossorigin src=./assets/index.js type=module></script>');
    expect(result.stylesheetReferences[0]?.crossoriginAttributeRange).toBeUndefined();
  });

  it('uses one normalized module-type contract before and after rewrite', () => {
    const beforeHtml = '<!doctype html><html><head></head><body><script type=MoDuLe src=./assets/index.js></script></body></html>';
    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html: beforeHtml, htmlFileName: 'index.html' }))
      .not.toThrow();

    const preRuntimeModule = `<script id="initial-module" type=MODULE ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}">globalThis.value = true</script>`;
    const afterHtml = `<!doctype html><html><head>${preRuntimeModule}${generatedScripts()}</head><body></body></html>`;
    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({ html: afterHtml, htmlFileName: 'index.html' }))
      .toThrow('Native module script remains in standalone HTML');
  });

  it('keeps source offsets aligned after non-ASCII HTML content', () => {
    const script = '<script src=./assets/index.js type=module></script>';
    const html = `<!doctype html><html><head><title>日本語😀</title></head><body>${script}</body></html>`;

    const result = assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' });
    expect(html.slice(result.applicationEntry.startOffset, result.applicationEntry.endOffset)).toBe(script);
  });

  it('rejects an application entry whose closing script tag is missing', () => {
    const html = '<!doctype html><html><head></head><body><script src=./assets/index.js type=module><main>must remain outside script</main></body></html>';

    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' }))
      .toThrow('Vite application entry must have an explicit closing script tag');
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

  it('rejects base href because it changes browser resolution of validated local output URLs', () => {
    const html = '<!doctype html><html><head><base href="./nested/"><link rel="stylesheet" href="./assets/index.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>';

    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' }))
      .toThrow('Standalone HTML must not define base href');
  });

  it.each([
    '<link rel="stylesheet" media="print" href="./assets/index.css">',
    '<link rel="stylesheet" disabled href="./assets/index.css">',
    '<link rel="alternate stylesheet" href="./assets/index.css">',
    '<link rel="stylesheet" title="alternate theme" href="./assets/index.css">',
    '<link rel="stylesheet" type="text/plain" href="./assets/index.css">',
  ])('preserves conditional public stylesheets for UI ownership classification: %s', stylesheet => {
    const html = `<!doctype html><html><head>${stylesheet}</head><body><script type="module" src="./assets/index.js"></script></body></html>`;

    const result = assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' });
    expect(result.stylesheetReferences).toHaveLength(1);
    expect(result.stylesheetReferences[0]?.unconditional).toBe(false);
    expect(result.stylesheetReferences[0]?.inHead).toBe(true);
  });

  it('records whether an existing stylesheet is a direct child of head', () => {
    const html = '<!doctype html><html><head></head><body><link rel=stylesheet href=./public.css><script type=module src=./assets/index.js></script></body></html>';
    const result = assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' });

    expect(result.stylesheetReferences[0]?.inHead).toBe(false);
  });

  it('accepts media=all as an unconditional stylesheet contract', () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" media=" ALL " href="./assets/index.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>';

    const result = assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' });
    expect(result.stylesheetReferences[0]?.unconditional).toBe(true);
  });

  it('accepts an explicit text/css stylesheet type as unconditional', () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" type=" TEXT/CSS ; charset=utf-8 " href="./assets/index.css"></head><body><script type="module" src="./assets/index.js"></script></body></html>';

    const result = assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' });
    expect(result.stylesheetReferences[0]?.unconditional).toBe(true);
  });

  it('rejects CSP meta because the generated standalone runtime does not model arbitrary CSP policies', () => {
    const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body><script type="module" src="./assets/index.js"></script></body></html>';

    expect(() => assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: 'index.html' }))
      .toThrow('Standalone HTML must not define Content-Security-Policy meta');
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

    expect(resolveFileProtocolStandaloneHtmlReference({
      reference: './assets/theme%20%23%20%25%20%E6%97%A5%E6%9C%AC%E8%AA%9E.css',
      htmlFileName: 'index.html',
      attribute: 'stylesheet href',
    })).toBe('assets/theme # % 日本語.css');

    for (const reference of ['https://example.com/a.js', './a.js?x=1', './a.js#x', './assets%2Fsecret.js', '.\\assets\\index.js']) {
      expect(() => resolveFileProtocolStandaloneHtmlReference({
        reference,
        htmlFileName: 'index.html',
        attribute: 'script src',
      })).toThrow();
    }
  });

  it('returns normalized final stylesheet outputs from parsed HTML after rewrite', () => {
    const html = `<!doctype html><html><head>${preRuntimeScript()}<link href=./assets/index.css rel=stylesheet>${generatedScripts()}</head><body></body></html>`;

    expect(assertFileProtocolStandaloneHtmlAfterRewrite({ html, htmlFileName: 'index.html' }))
      .toEqual(['assets/index.css']);
  });

  it('rejects duplicate normalized stylesheet outputs after rewrite', () => {
    const html = `<!doctype html><html><head><link rel=stylesheet href=./assets/index.css><link href=./assets/index.css rel=stylesheet>${generatedScripts()}</head><body></body></html>`;

    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({ html, htmlFileName: 'index.html' }))
      .toThrow('Standalone HTML links stylesheet output more than once: assets/index.css');
  });

  it('rejects crossorigin on final local stylesheets after rewrite', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" crossorigin href="./assets/index.css">${generatedScripts()}</head><body></body></html>`;

    expect(() => assertFileProtocolStandaloneHtmlAfterRewrite({ html, htmlFileName: 'index.html' }))
      .toThrow('Final standalone stylesheet still has crossorigin');
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
