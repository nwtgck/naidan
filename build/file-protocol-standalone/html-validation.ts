import path from 'node:path';
import { JSDOM } from 'jsdom';

import {
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';

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

function normalizedScriptType({ script }: Readonly<{script: HTMLScriptElement}>): string {
  return (script.getAttribute('type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isExecutableScript(script: HTMLScriptElement): boolean {
  const normalized = normalizedScriptType({ script });
  return normalized === '' || executableScriptTypes.has(normalized);
}

function isModuleScript({ script }: Readonly<{script: HTMLScriptElement}>): boolean {
  return normalizedScriptType({ script }) === 'module';
}

function isPreRuntimeScript(script: HTMLScriptElement): boolean {
  return script.getAttribute(FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE)
    === FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE;
}

function assertValidPreRuntimeScript(script: HTMLScriptElement): void {
  if (script.id === '') {
    throw new Error(`[${pluginName}] A pre-runtime script must have a stable id.`);
  }
  if (script.hasAttribute('src')) {
    throw new Error(`[${pluginName}] Pre-runtime script ${JSON.stringify(script.id)} must be inline.`);
  }
  if (script.parentElement?.tagName !== 'HEAD') {
    throw new Error(`[${pluginName}] Pre-runtime script ${JSON.stringify(script.id)} must be in <head>.`);
  }
}

function hasRelToken(link: HTMLLinkElement, token: string): boolean {
  return (link.getAttribute('rel') ?? '')
    .split(/\s+/u)
    .some(value => value.toLowerCase() === token);
}

export function resolveFileProtocolStandaloneHtmlReference({
  reference,
  htmlFileName,
  attribute,
}: Readonly<{
  reference: string;
  htmlFileName: string;
  attribute: string;
}>): string {
  const trimmed = reference.trim();
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('\\')) {
    throw new Error(`[${pluginName}] ${attribute} must be a relative local output URL: ${reference}`);
  }
  if (/%(?:2f|5c)/iu.test(trimmed)) {
    throw new Error(`[${pluginName}] ${attribute} must not contain an encoded path separator: ${reference}`);
  }

  const rootUrl = new URL('https://file-protocol-standalone.invalid/__output__/');
  const htmlDirectory = path.posix.dirname(htmlFileName);
  const baseUrl = new URL(htmlDirectory === '.' ? './' : `./${htmlDirectory}/`, rootUrl);
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    throw new Error(`[${pluginName}] ${attribute} is not a valid URL: ${reference}`);
  }
  if (
    resolved.origin !== rootUrl.origin
    || !resolved.pathname.startsWith(rootUrl.pathname)
    || resolved.search !== ''
    || resolved.hash !== ''
  ) {
    throw new Error(`[${pluginName}] ${attribute} must identify one local output file without a query or fragment: ${reference}`);
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(resolved.pathname.slice(rootUrl.pathname.length));
  } catch {
    throw new Error(`[${pluginName}] ${attribute} contains invalid percent encoding: ${reference}`);
  }
  const segments = decodedPath.split('/');
  if (
    decodedPath === ''
    || decodedPath.includes('\\')
    || decodedPath.includes('\0')
    || /^[A-Za-z]:/u.test(decodedPath)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`[${pluginName}] ${attribute} must remain a normalized relative output path: ${reference}`);
  }
  return decodedPath;
}

function isUnconditionalStylesheetLink({ link }: Readonly<{link: HTMLLinkElement}>): boolean {
  const media = (link.getAttribute('media') ?? '').trim().toLowerCase();
  const stylesheetType = (link.getAttribute('type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return !hasRelToken(link, 'alternate')
    && !link.hasAttribute('disabled')
    && !link.hasAttribute('title')
    && (media === '' || media === 'all')
    && (stylesheetType === '' || stylesheetType === 'text/css');
}

type ValidatedStylesheetLink = Readonly<{
  element: HTMLLinkElement;
  fileName: string;
}>;

function assertLinkContracts({
  document,
  htmlFileName,
  stylesheetCrossorigin,
}: Readonly<{
  document: Document;
  htmlFileName: string;
  stylesheetCrossorigin: 'allowed' | 'forbidden';
}>): readonly ValidatedStylesheetLink[] {
  if (document.querySelector('base[href]') !== null) {
    throw new Error(`[${pluginName}] Standalone HTML must not define base href because generated output URLs are relative to the HTML file.`);
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[http-equiv]')) {
    if ((meta.getAttribute('http-equiv') ?? '').trim().toLowerCase() === 'content-security-policy') {
      throw new Error(`[${pluginName}] Standalone HTML must not define Content-Security-Policy meta because the generated runtime does not model arbitrary CSP policies.`);
    }
  }

  const stylesheetLinks: ValidatedStylesheetLink[] = [];
  const stylesheetFileNames = new Set<string>();
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel]')) {
    if (hasRelToken(link, 'modulepreload') || hasRelToken(link, 'preload')) {
      throw new Error(`[${pluginName}] Standalone HTML must not contain preload links: ${link.outerHTML}`);
    }
    if (!hasRelToken(link, 'stylesheet')) continue;
    const href = link.getAttribute('href');
    if (href === null) throw new Error(`[${pluginName}] Standalone stylesheet link is missing href.`);
    const stylesheetFileName = resolveFileProtocolStandaloneHtmlReference({
      reference: href,
      htmlFileName,
      attribute: 'stylesheet href',
    });
    if (stylesheetFileNames.has(stylesheetFileName)) {
      throw new Error(`[${pluginName}] Standalone HTML links stylesheet output more than once: ${stylesheetFileName}`);
    }
    stylesheetFileNames.add(stylesheetFileName);
    stylesheetLinks.push({ element: link, fileName: stylesheetFileName });
    if (stylesheetCrossorigin === 'forbidden' && link.hasAttribute('crossorigin')) {
      throw new Error(`[${pluginName}] Final standalone stylesheet still has crossorigin: ${link.outerHTML}`);
    }
  }
  return stylesheetLinks;
}

export type FileProtocolStandaloneHtmlSourceRange = Readonly<{
  startOffset: number;
  endOffset: number;
}>;

export type FileProtocolStandaloneHtmlApplicationEntry = Readonly<{
  source: string;
  startOffset: number;
  endOffset: number;
}>;

export type FileProtocolStandaloneHtmlStylesheetReference = FileProtocolStandaloneHtmlSourceRange & Readonly<{
  fileName: string;
  unconditional: boolean;
  inHead: boolean;
  crossoriginAttributeRange: FileProtocolStandaloneHtmlSourceRange | undefined;
}>;

function isHtmlSourceRange(value: unknown): value is FileProtocolStandaloneHtmlSourceRange {
  if (value === null || typeof value !== 'object') return false;
  return 'startOffset' in value
    && typeof value.startOffset === 'number'
    && 'endOffset' in value
    && typeof value.endOffset === 'number';
}

function isAttributeLocationMap(
  value: unknown,
): value is Readonly<Record<string, FileProtocolStandaloneHtmlSourceRange>> {
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).every(isHtmlSourceRange);
}

function collectStylesheetReferences({
  dom,
  stylesheetLinks,
}: Readonly<{
  dom: JSDOM;
  stylesheetLinks: readonly ValidatedStylesheetLink[];
}>): readonly FileProtocolStandaloneHtmlStylesheetReference[] {
  return stylesheetLinks.map(({ element, fileName }) => {
    const location = dom.nodeLocation(element);
    if (location === null || location === undefined) {
      throw new Error(`[${pluginName}] Unable to locate a stylesheet link in source HTML.`);
    }

    let crossoriginAttributeRange: FileProtocolStandaloneHtmlSourceRange | undefined;
    if (element.hasAttribute('crossorigin')) {
      if (!('attrs' in location) || !isAttributeLocationMap(location.attrs)) {
        throw new Error(`[${pluginName}] Unable to locate stylesheet attributes in source HTML.`);
      }
      const crossoriginLocation = location.attrs.crossorigin;
      if (crossoriginLocation === undefined) {
        throw new Error(`[${pluginName}] Unable to locate stylesheet crossorigin in source HTML.`);
      }
      crossoriginAttributeRange = {
        startOffset: crossoriginLocation.startOffset,
        endOffset: crossoriginLocation.endOffset,
      };
    }

    return {
      fileName,
      unconditional: isUnconditionalStylesheetLink({ link: element }),
      inHead: element.parentElement?.tagName === 'HEAD',
      crossoriginAttributeRange,
      startOffset: location.startOffset,
      endOffset: location.endOffset,
    };
  });
}

export function assertFileProtocolStandaloneHtmlBeforeRewrite({
  html,
  htmlFileName,
}: Readonly<{html: string; htmlFileName: string}>): Readonly<{
  stylesheetReferences: readonly FileProtocolStandaloneHtmlStylesheetReference[];
  applicationEntry: FileProtocolStandaloneHtmlApplicationEntry;
}> {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  const document = dom.window.document;
  try {
    for (const id of FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS) {
      if (document.getElementById(id) !== null) {
        throw new Error(`[${pluginName}] HTML already contains reserved standalone element id ${JSON.stringify(id)}.`);
      }
    }
    const stylesheetLinks = assertLinkContracts({
      document,
      htmlFileName,
      stylesheetCrossorigin: 'allowed',
    });
    const stylesheetReferences = collectStylesheetReferences({
      dom,
      stylesheetLinks,
    });
    const executableScripts = Array.from(document.querySelectorAll('script')).filter(isExecutableScript);
    const preRuntimeScripts = executableScripts.filter(isPreRuntimeScript);
    for (const script of preRuntimeScripts) assertValidPreRuntimeScript(script);
    const applicationScripts = executableScripts.filter(script => !isPreRuntimeScript(script));
    if (applicationScripts.length !== 1) {
      throw new Error(`[${pluginName}] Expected exactly one Vite application entry script; found ${applicationScripts.length}.`);
    }
    const applicationScript = applicationScripts[0];
    if (applicationScript === undefined || !isModuleScript({ script: applicationScript }) || !applicationScript.hasAttribute('src')) {
      throw new Error(`[${pluginName}] The Vite application entry must be an external module script.`);
    }
    const source = applicationScript.getAttribute('src');
    if (source === null) {
      throw new Error(`[${pluginName}] The Vite application entry must have src.`);
    }
    const location = dom.nodeLocation(applicationScript);
    if (location === null || location === undefined) {
      throw new Error(`[${pluginName}] Unable to locate the Vite application entry in source HTML.`);
    }
    if (!('endTag' in location) || location.endTag === undefined) {
      throw new Error(`[${pluginName}] Vite application entry must have an explicit closing script tag.`);
    }
    return {
      stylesheetReferences,
      applicationEntry: {
        source,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
      },
    };
  } finally {
    dom.window.close();
  }
}

export function assertFileProtocolStandaloneHtmlAfterRewrite({
  html,
  htmlFileName,
}: Readonly<{html: string; htmlFileName: string}>): readonly string[] {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  try {
    const stylesheetLinks = assertLinkContracts({
      document,
      htmlFileName,
      stylesheetCrossorigin: 'forbidden',
    });
    const executableScripts = Array.from(document.querySelectorAll('script')).filter(isExecutableScript);
    const preRuntimeScripts = executableScripts.filter(isPreRuntimeScript);
    for (const script of preRuntimeScripts) assertValidPreRuntimeScript(script);
    const generatedScripts = executableScripts.filter(script => !isPreRuntimeScript(script));
    const actualIds = generatedScripts.map(script => script.id);
    if (JSON.stringify(actualIds) !== JSON.stringify(FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS)) {
      throw new Error(`[${pluginName}] Final executable script order is invalid: ${actualIds.join(', ')}.`);
    }

    const firstGeneratedScript = generatedScripts[0];
    if (firstGeneratedScript === undefined) {
      throw new Error(`[${pluginName}] Final executable scripts are missing.`);
    }
    for (const script of preRuntimeScripts) {
      if ((script.compareDocumentPosition(firstGeneratedScript) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
        throw new Error(`[${pluginName}] Pre-runtime script ${JSON.stringify(script.id)} must run before generated runtime scripts.`);
      }
    }
    for (const id of FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS) {
      const matches = Array.from(document.querySelectorAll('[id]')).filter(element => element.id === id);
      if (matches.length !== 1 || matches[0]?.tagName !== 'SCRIPT') {
        throw new Error(`[${pluginName}] Expected exactly one generated script with id ${JSON.stringify(id)}.`);
      }
    }
    for (const script of executableScripts) {
      if (isModuleScript({ script })) {
        throw new Error(`[${pluginName}] Native module script remains in standalone HTML.`);
      }
      if (script.hasAttribute('crossorigin')) {
        throw new Error(`[${pluginName}] Executable script still has crossorigin in standalone HTML.`);
      }
      const src = script.getAttribute('src');
      if (src !== null) {
        resolveFileProtocolStandaloneHtmlReference({
          reference: src,
          htmlFileName,
          attribute: `script#${script.id} src`,
        });
      }
    }
    return stylesheetLinks.map(({ fileName }) => fileName);
  } finally {
    dom.window.close();
  }
}
