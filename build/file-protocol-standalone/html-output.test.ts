import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../../src/file-protocol-standalone-protocol';
import {
  assertValidFileProtocolStandaloneHtml,
  replaceLegacyBootstrapWithFileProtocolStandaloneScripts,
} from './html-output';

function createLegacyHtml({ preservedScript }: {
  preservedScript: string,
}): string {
  return `\
<!doctype html>
<html>
  <head>
    ${preservedScript}
  </head>
  <body>
    <div id="app"></div>
    <script nomodule id="vite-legacy-entry" data-src="assets/index.js">System.import('./assets/index.js')</script>
  </body>
</html>
`;
}

function transformStandaloneHtml({ preservedScript }: {
  preservedScript: string,
}): string {
  return replaceLegacyBootstrapWithFileProtocolStandaloneScripts({
    html: createLegacyHtml({ preservedScript }),
    entryFileName: 'assets/index.js',
    runtimeFileName: 'assets/system.js',
    patchFileName: 'assets/file-patch.js',
    retryFileName: 'assets/retry.js',
    workers: [],
  });
}

describe('file protocol standalone preserved pre-runtime scripts', () => {
  it('keeps an explicitly marked inline head script before generated runtime scripts', () => {
    const html = transformStandaloneHtml({
      preservedScript: `<script id="initial-theme" ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}">globalThis.initialThemeApplied = true</script>`,
    });
    const dom = new JSDOM(html);
    const executableScripts = Array.from(dom.window.document.querySelectorAll('script')).filter((script) => (
      script.getAttribute('type') !== 'application/json'
    ));

    expect(executableScripts.map((script) => script.id)).toEqual([
      'initial-theme',
      ...FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
    ]);
    expect(dom.window.document.getElementById('initial-theme')?.parentElement?.tagName).toBe('HEAD');
    expect(() => assertValidFileProtocolStandaloneHtml({ html })).not.toThrow();
  });

  it('rejects a marked external script because it could delay or reorder pre-runtime execution', () => {
    expect(() => transformStandaloneHtml({
      preservedScript: `<script id="initial-theme" ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}" src="./theme.js"></script>`,
    })).toThrow('must be inline');
  });

  it('rejects a marked body script because it would no longer protect the first paint', () => {
    const preservedScript = `<script id="initial-theme" ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}">globalThis.initialThemeApplied = true</script>`;
    const html = createLegacyHtml({ preservedScript: '' }).replace(
      '<div id="app"></div>',
      `<div id="app"></div>${preservedScript}`,
    );

    expect(() => replaceLegacyBootstrapWithFileProtocolStandaloneScripts({
      html,
      entryFileName: 'assets/index.js',
      runtimeFileName: 'assets/system.js',
      patchFileName: 'assets/file-patch.js',
      retryFileName: 'assets/retry.js',
      workers: [],
    })).toThrow('must be in <head>');
  });
});
