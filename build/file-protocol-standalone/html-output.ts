import { JSDOM } from 'jsdom';

import { createFileProtocolStandaloneEntryBootstrapSource, debugSlowStartupNoticeDelayMs } from './systemjs';
import {
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../../src/file-protocol-standalone-protocol';
import type { BuiltFileProtocolStandaloneWorkerArtifact } from './worker';

const pluginName = 'file-protocol-standalone';

const executableScriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

function isExecutableScriptType({ type }: { type: string | null }): boolean {
  if (type === null || type.trim() === '') {
    return true;
  }
  const normalized = type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return executableScriptTypes.has(normalized);
}

function isPreservedPreRuntimeScript({ script }: {
  script: HTMLScriptElement,
}): boolean {
  return script.getAttribute(FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE)
    === FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE;
}

function assertValidPreservedPreRuntimeScript({ script }: {
  script: HTMLScriptElement,
}): void {
  if (script.id === '') {
    throw new Error(`[${pluginName}] A preserved pre-runtime script must have a stable id.`);
  }
  if (script.hasAttribute('src')) {
    throw new Error(`[${pluginName}] Preserved pre-runtime script ${JSON.stringify(script.id)} must be inline.`);
  }
  if (script.parentElement?.tagName !== 'HEAD') {
    throw new Error(`[${pluginName}] Preserved pre-runtime script ${JSON.stringify(script.id)} must be in <head>.`);
  }
}

export function parseRelativeOutputFileName({ value, attribute }: {
  value: string,
  attribute: string,
}): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error(`[${pluginName}] ${attribute} must be a relative local output URL: ${value}`);
  }

  const baseUrl = new URL('https://file-protocol-standalone.invalid/__output__/');
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    throw new Error(`[${pluginName}] ${attribute} is not a valid URL: ${value}`);
  }
  if (
    resolved.origin !== baseUrl.origin
    || !resolved.pathname.startsWith(baseUrl.pathname)
    || resolved.search !== ''
    || resolved.hash !== ''
  ) {
    throw new Error(`[${pluginName}] ${attribute} must identify one local output file without a query or fragment: ${value}`);
  }

  if (/%(?:2f|5c)/i.test(resolved.pathname)) {
    throw new Error(`[${pluginName}] ${attribute} must not contain an encoded path separator: ${value}`);
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(resolved.pathname);
  } catch {
    throw new Error(`[${pluginName}] ${attribute} contains invalid percent encoding: ${value}`);
  }
  const outputPrefix = decodeURIComponent(baseUrl.pathname);
  const fileName = decodedPath.slice(outputPrefix.length);
  const segments = fileName.split('/');
  if (
    fileName.includes('\\')
    || fileName.includes('\0')
    || /^[A-Za-z]:/.test(fileName)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`[${pluginName}] ${attribute} must remain a normalized relative output path: ${value}`);
  }
  return fileName;
}

export function replaceLegacyBootstrapWithFileProtocolStandaloneScripts({
  html,
  entryFileName,
  runtimeFileName,
  patchFileName,
  retryFileName,
  workers,
}: {
  html: string,
  entryFileName: string,
  runtimeFileName: string,
  patchFileName: string,
  retryFileName: string,
  workers: readonly BuiltFileProtocolStandaloneWorkerArtifact[],
}): string {
  const dom = new JSDOM(html);
  const { document } = dom.window;

  for (const id of FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS) {
    const collisions = Array.from(document.querySelectorAll('[id]')).filter((element) => element.id === id);
    if (collisions.length > 0) {
      throw new Error(`[${pluginName}] index.html already contains reserved standalone element id ${JSON.stringify(id)}.`);
    }
  }

  const modulePreloads = Array.from(document.querySelectorAll('link[rel]')).filter((link) => (
    (link.getAttribute('rel') ?? '')
      .split(/\s+/)
      .some((token) => token.toLowerCase() === 'modulepreload')
  ));
  if (modulePreloads.length > 0) {
    throw new Error(
      `[${pluginName}] Expected @vitejs/plugin-legacy to remove modulepreload links; found ${modulePreloads.length}.`,
    );
  }

  const executableScripts = Array.from(document.querySelectorAll('script'))
    .filter((script) => isExecutableScriptType({ type: script.getAttribute('type') }));
  /**
   * WHY: The saved theme must run before the external SystemJS runtime to avoid
   * the measured white first paint. Preserve only explicitly marked inline head
   * scripts so the standalone transform remains fail-closed for every other
   * executable script.
   */
  const preservedPreRuntimeScripts = executableScripts.filter((script) => (
    isPreservedPreRuntimeScript({ script })
  ));
  for (const script of preservedPreRuntimeScripts) {
    assertValidPreservedPreRuntimeScript({ script });
  }
  const legacyEntries = executableScripts.filter((script) => script.id === 'vite-legacy-entry');
  if (legacyEntries.length !== 1) {
    throw new Error(`[${pluginName}] Expected exactly one @vitejs/plugin-legacy entry script; found ${legacyEntries.length}.`);
  }
  const legacyPolyfills = executableScripts.filter((script) => script.id === 'vite-legacy-polyfill');
  if (legacyPolyfills.length > 0) {
    throw new Error(`[${pluginName}] Legacy polyfill scripts are unsupported when externalSystemJS and polyfills are disabled.`);
  }

  const legacyEntry = legacyEntries[0];
  if (legacyEntry.hasAttribute('src')) {
    throw new Error(`[${pluginName}] The @vitejs/plugin-legacy entry must be an inline bootstrap script.`);
  }
  const dataSrc = legacyEntry.getAttribute('data-src');
  if (dataSrc === null) {
    throw new Error(`[${pluginName}] The @vitejs/plugin-legacy entry is missing data-src.`);
  }
  const legacyEntryFileName = parseRelativeOutputFileName({ value: dataSrc, attribute: 'legacy entry data-src' });
  if (legacyEntryFileName !== entryFileName) {
    throw new Error(
      `[${pluginName}] Legacy entry data-src does not match the generated entry chunk: ${legacyEntryFileName} !== ${entryFileName}.`,
    );
  }

  const unexpectedScripts = executableScripts.filter((script) => (
    script !== legacyEntry
    && !isPreservedPreRuntimeScript({ script })
  ));
  if (unexpectedScripts.length > 0) {
    const descriptions = unexpectedScripts.map((script) => {
      const id = script.id === '' ? '(no id)' : script.id;
      const src = script.getAttribute('src') ?? '(inline)';
      return `${id}:${src}`;
    });
    throw new Error(
      `[${pluginName}] Unexpected executable script(s) in index.html; refusing to remove them: ${descriptions.join(', ')}.`,
    );
  }
  legacyEntry.remove();

  const appendClassicScript = ({ id, src, source }: {
    id: string,
    src: string | undefined,
    source: string | undefined,
  }): void => {
    const script = document.createElement('script');
    script.id = id;
    if (src !== undefined) {
      script.setAttribute('src', src);
    }
    if (source !== undefined) {
      script.textContent = source;
    }
    document.body.appendChild(script);
  };

  appendClassicScript({
    id: FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime,
    src: `./${runtimeFileName}`,
    source: undefined,
  });
  appendClassicScript({
    id: FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch,
    src: `./${patchFileName}`,
    source: undefined,
  });
  appendClassicScript({
    id: FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook,
    src: `./${retryFileName}`,
    source: undefined,
  });

  const manifestScript = document.createElement('script');
  manifestScript.id = FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.workerManifest;
  manifestScript.type = 'application/json';
  manifestScript.textContent = JSON.stringify(Object.fromEntries(workers.map((worker) => [worker.id, {
    registryScript: `./${worker.registryFileName}`,
    sourceBytes: worker.sourceBytes,
    sourcePartCount: worker.sourcePartCount,
    sha256: worker.sha256,
  }])));
  document.body.appendChild(manifestScript);

  appendClassicScript({
    id: FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap,
    src: undefined,
    source: createFileProtocolStandaloneEntryBootstrapSource({
      entryFileName,
      debugSlowStartupNoticeDelayMs,
    }),
  });

  return dom.serialize();
}

export function assertValidFileProtocolStandaloneHtml({ html }: { html: string }): void {
  const dom = new JSDOM(html);
  const executableScripts = Array.from(dom.window.document.querySelectorAll('script'))
    .filter((script) => isExecutableScriptType({ type: script.getAttribute('type') }));
  const preservedPreRuntimeScripts = executableScripts.filter((script) => (
    isPreservedPreRuntimeScript({ script })
  ));
  for (const script of preservedPreRuntimeScripts) {
    assertValidPreservedPreRuntimeScript({ script });
  }

  const generatedExecutableScripts = executableScripts.filter((script) => (
    !isPreservedPreRuntimeScript({ script })
  ));
  const expectedIds = FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS;
  const actualIds = generatedExecutableScripts.map((script) => script.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`[${pluginName}] Final executable script order is invalid: ${actualIds.join(', ')}.`);
  }

  const firstGeneratedScript = generatedExecutableScripts[0];
  if (firstGeneratedScript === undefined) {
    throw new Error(`[${pluginName}] Final executable scripts are missing.`);
  }
  for (const script of preservedPreRuntimeScripts) {
    if ((script.compareDocumentPosition(firstGeneratedScript) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
      throw new Error(`[${pluginName}] Preserved pre-runtime script ${JSON.stringify(script.id)} must run before generated runtime scripts.`);
    }
  }
  for (const id of FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS) {
    const matches = Array.from(dom.window.document.querySelectorAll('[id]')).filter((element) => element.id === id);
    if (matches.length !== 1) {
      throw new Error(`[${pluginName}] Expected exactly one generated element with id ${JSON.stringify(id)}; found ${matches.length}.`);
    }
    if (matches[0]?.tagName !== 'SCRIPT') {
      throw new Error(`[${pluginName}] Generated standalone element ${JSON.stringify(id)} must be a script.`);
    }
  }
  const manifest = dom.window.document.getElementById(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.workerManifest);
  if (manifest === null || manifest.getAttribute('type') !== 'application/json') {
    throw new Error(`[${pluginName}] Worker manifest script is missing or has an unexpected type.`);
  }
  const entryScript = dom.window.document.getElementById(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap);
  if (entryScript === null || (manifest.compareDocumentPosition(entryScript) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
    throw new Error(`[${pluginName}] Worker manifest must appear before the standalone entry bootstrap.`);
  }
  for (const script of executableScripts) {
    if (script.getAttribute('type') === 'module') {
      throw new Error(`[${pluginName}] Native module script remains in index.html.`);
    }
    if (script.hasAttribute('crossorigin')) {
      throw new Error(`[${pluginName}] Executable script still has crossorigin in index.html.`);
    }
    const src = script.getAttribute('src');
    if (src !== null) {
      parseRelativeOutputFileName({ value: src, attribute: `script#${script.id} src` });
    }
  }
}
