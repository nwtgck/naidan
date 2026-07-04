import { createHash } from 'node:crypto';
import path from 'node:path';

import { transformAsync, types as t } from '@babel/core';
import type { PluginObj, TransformOptions } from '@babel/core';
import transformDynamicImport from '@babel/plugin-transform-dynamic-import';
import transformModulesSystemjs from '@babel/plugin-transform-modules-systemjs';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import type {
  ExistingRawSourceMap,
  SourceMap,
  OutputAsset,
  OutputBundle,
  OutputChunk,
  RenderedChunk,
  SourceMapInput,
} from 'rolldown';
import type { Plugin, ResolvedConfig } from 'vite';

import { parseRelativeOutputFileName } from './file-protocol-standalone/html-output';
import { assertFileProtocolStandaloneClassicScript } from './file-protocol-standalone/javascript-validation';

const pluginName = 'file-protocol-systemjs-transform';
const systemJsChunkMarker = '-systemjs-';
const legacyChunkMarker = '-legacy-';
const inlinedCssAttribute = 'data-naidan-file-protocol-css';

export type FileProtocolSystemJsOptions = Readonly<{
  diagnostics: 'emit' | 'omit',
}>;

type FileProtocolSystemJsTiming = {
  chunks: number,
  babelMs: number,
  cssInjectionMs: number,
  cssAssets: number,
  cssInputBytes: number,
  inputBytes: number,
  outputBytesBeforeMinify: number,
};

type RuntimeCssUrl = Readonly<{
  token: string,
  relativeUrl: string,
}>;

type RuntimeCssTemplate = Readonly<{
  css: string,
  runtimeUrls: readonly RuntimeCssUrl[],
}>;

type InlinedCssAsset = Readonly<{
  fileName: string,
  source: string,
  styleId: string,
  template: RuntimeCssTemplate,
}>;

type BabelInputSourceMap = NonNullable<TransformOptions['inputSourceMap']>;

function toBabelInputSourceMap({ map, fileName }: {
  map: ExistingRawSourceMap,
  fileName: string,
}): BabelInputSourceMap {
  if (map.version !== 3) {
    throw new Error(`[${pluginName}] ${fileName} source map must use version 3.`);
  }
  const sources = map.sources;
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string')) {
    throw new Error(`[${pluginName}] ${fileName} source map has invalid sources.`);
  }
  const names = map.names;
  if (names !== undefined && (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))) {
    throw new Error(`[${pluginName}] ${fileName} source map has invalid names.`);
  }
  const sourcesContent = map.sourcesContent;
  if (
    sourcesContent !== undefined
    && (!Array.isArray(sourcesContent) || sourcesContent.some((source) => typeof source !== 'string'))
  ) {
    throw new Error(`[${pluginName}] ${fileName} source map has invalid sourcesContent.`);
  }
  if (typeof map.mappings !== 'string') {
    throw new Error(`[${pluginName}] ${fileName} source map has invalid mappings.`);
  }
  return {
    version: map.version,
    sources: sources as string[],
    names: names === undefined ? [] : names as string[],
    sourceRoot: map.sourceRoot,
    sourcesContent: sourcesContent === undefined ? undefined : sourcesContent as string[],
    mappings: map.mappings,
    file: map.file ?? path.posix.basename(fileName),
  };
}

function readInlineSourceMap({ code, fileName }: {
  code: string,
  fileName: string,
}): BabelInputSourceMap {
  const matches = [...code.matchAll(/sourceMappingURL=(data:application\/json[^\s*]+)/gu)];
  const sourceMapUrl = matches.at(-1)?.[1];
  if (sourceMapUrl === undefined) {
    throw new Error(`[${pluginName}] ${fileName} is missing an inline source map.`);
  }
  const commaIndex = sourceMapUrl.indexOf(',');
  if (commaIndex === -1) {
    throw new Error(`[${pluginName}] ${fileName} has an invalid inline source-map data URL.`);
  }
  const metadata = sourceMapUrl.slice(0, commaIndex);
  const payload = sourceMapUrl.slice(commaIndex + 1);
  const json = metadata.endsWith(';base64')
    ? Buffer.from(payload, 'base64').toString('utf8')
    : decodeURIComponent(payload);
  const normalizedMap = normalizeSourceMap({ map: json });
  if (normalizedMap === undefined) {
    throw new Error(`[${pluginName}] ${fileName} inline source map is empty.`);
  }
  return toBabelInputSourceMap({ map: normalizedMap, fileName });
}

function stripSourceMapComments({ code }: { code: string }): string {
  return code
    .replace(/\n?\/\/[#@]\s*sourceMappingURL=[^\s]+\s*$/gu, '')
    .replace(/\n?\/\*[#@]\s*sourceMappingURL=[^*]+\*\/\s*$/gu, '');
}

function createEmptyTiming(): FileProtocolSystemJsTiming {
  return {
    chunks: 0,
    babelMs: 0,
    cssInjectionMs: 0,
    cssAssets: 0,
    cssInputBytes: 0,
    inputBytes: 0,
    outputBytesBeforeMinify: 0,
  };
}

function normalizeSourceMap({ map }: { map: unknown }): ExistingRawSourceMap | undefined {
  if (map === undefined || map === null) {
    return undefined;
  }
  if (typeof map === 'string') {
    return JSON.parse(map) as ExistingRawSourceMap;
  }
  if (typeof map !== 'object') {
    throw new Error(`[${pluginName}] Expected a source-map object or string.`);
  }
  if (!('version' in map) && 'toString' in map && typeof map.toString === 'function') {
    return JSON.parse(map.toString()) as ExistingRawSourceMap;
  }
  return map as ExistingRawSourceMap;
}

function readAssetSource({ asset }: { asset: OutputAsset }): string {
  return typeof asset.source === 'string'
    ? asset.source
    : Buffer.from(asset.source).toString('utf8');
}

function isStaticCssUrl({ value }: { value: string }): boolean {
  return value === ''
    || value.startsWith('#')
    || /^(?:data|blob):/iu.test(value);
}

function assertSupportedLocalCssUrl({ value, cssFileName }: {
  value: string,
  cssFileName: string,
}): void {
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('//')) {
    throw new Error(
      `[${pluginName}] CSS URL ${JSON.stringify(value)} in ${cssFileName} must be relative for file:// output.`,
    );
  }
  const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/u.exec(value)?.[1];
  if (scheme !== undefined) {
    throw new Error(
      `[${pluginName}] CSS URL ${JSON.stringify(value)} in ${cssFileName} uses unsupported scheme ${scheme}.`,
    );
  }
}

function splitUrlSuffix({ value }: { value: string }): Readonly<{
  pathname: string,
  suffix: string,
}> {
  const suffixIndex = value.search(/[?#]/u);
  return suffixIndex === -1
    ? { pathname: value, suffix: '' }
    : { pathname: value.slice(0, suffixIndex), suffix: value.slice(suffixIndex) };
}

function createRuntimeCssUrl({
  value,
  cssFileName,
  chunkFileName,
}: {
  value: string,
  cssFileName: string,
  chunkFileName: string,
}): string | undefined {
  const trimmed = value.trim();
  if (isStaticCssUrl({ value: trimmed })) {
    return undefined;
  }
  assertSupportedLocalCssUrl({ value: trimmed, cssFileName });
  const { pathname, suffix } = splitUrlSuffix({ value: trimmed });
  if (pathname === '') {
    if (suffix.startsWith('?')) {
      throw new Error(
        `[${pluginName}] CSS URL ${JSON.stringify(value)} in ${cssFileName} cannot target the removed CSS asset.`,
      );
    }
    return undefined;
  }
  if (pathname.includes('\\') || /%(?:2f|5c)/iu.test(pathname)) {
    throw new Error(`[${pluginName}] CSS URL ${JSON.stringify(value)} in ${cssFileName} contains a path separator escape.`);
  }
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw new Error(`[${pluginName}] CSS URL ${JSON.stringify(value)} in ${cssFileName} has invalid percent encoding.`);
  }
  const decodedTargetFileName = path.posix.normalize(path.posix.join(
    path.posix.dirname(cssFileName),
    decodedPathname,
  ));
  if (
    decodedTargetFileName === '..'
    || decodedTargetFileName.startsWith('../')
    || decodedTargetFileName.startsWith('/')
  ) {
    throw new Error(
      `[${pluginName}] CSS URL ${JSON.stringify(value)} in ${cssFileName} escapes the output directory.`,
    );
  }
  const targetFileName = path.posix.normalize(path.posix.join(
    path.posix.dirname(cssFileName),
    pathname,
  ));
  const relativePath = path.posix.relative(
    path.posix.dirname(chunkFileName),
    targetFileName,
  );
  const normalizedRelativePath = relativePath.startsWith('.')
    ? relativePath
    : `./${relativePath}`;
  return `${normalizedRelativePath}${suffix}`;
}

function rewriteCssValueWithRuntimeUrls({
  value,
  cssFileName,
  chunkFileName,
  runtimeUrls,
}: {
  value: string,
  cssFileName: string,
  chunkFileName: string,
  runtimeUrls: RuntimeCssUrl[],
}): string {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') {
      return;
    }
    const meaningfulNodes = node.nodes.filter((child) => child.type !== 'space' && child.type !== 'comment');
    if (meaningfulNodes.length === 0) {
      return;
    }
    if (meaningfulNodes.length !== 1) {
      throw new Error(`[${pluginName}] CSS url() in ${cssFileName} must contain one static URL.`);
    }
    const urlNode = meaningfulNodes[0];
    if (urlNode.type !== 'string' && urlNode.type !== 'word') {
      throw new Error(`[${pluginName}] CSS url() in ${cssFileName} must contain one static URL.`);
    }
    if (
      urlNode.type === 'word'
      && (/\s/u.test(urlNode.value) || /[()]/u.test(urlNode.value))
    ) {
      throw new Error(`[${pluginName}] CSS url() in ${cssFileName} must contain one static URL.`);
    }
    const relativeUrl = createRuntimeCssUrl({
      value: urlNode.value,
      cssFileName,
      chunkFileName,
    });
    if (relativeUrl === undefined) {
      return;
    }
    const tokenDigest = createHash('sha256')
      .update(cssFileName)
      .update('\0')
      .update(chunkFileName)
      .digest('hex')
      .slice(0, 12);
    const token = `__NAIDAN_FILE_PROTOCOL_CSS_URL_${tokenDigest}_${runtimeUrls.length}__`;
    if (value.includes(token)) {
      throw new Error(`[${pluginName}] CSS URL placeholder collision in ${cssFileName}.`);
    }
    runtimeUrls.push({ token, relativeUrl });
    urlNode.value = token;
  });
  return valueParser.stringify(parsed.nodes);
}

/** @internal Exported for focused CSS-injection tests. */
export function createFileProtocolSystemJsRuntimeCssTemplate({
  source,
  cssFileName,
  chunkFileName,
}: {
  source: string,
  cssFileName: string,
  chunkFileName: string,
}): RuntimeCssTemplate {
  const runtimeUrls: RuntimeCssUrl[] = [];
  const root = postcss.parse(source, { from: cssFileName });
  root.walkDecls((declaration) => {
    declaration.value = rewriteCssValueWithRuntimeUrls({
      value: declaration.value,
      cssFileName,
      chunkFileName,
      runtimeUrls,
    });
  });
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === 'import') {
      throw new Error(`[${pluginName}] Final CSS asset ${cssFileName} must not contain @import.`);
    }
    atRule.params = rewriteCssValueWithRuntimeUrls({
      value: atRule.params,
      cssFileName,
      chunkFileName,
      runtimeUrls,
    });
  });
  return {
    css: root.toString(),
    runtimeUrls,
  };
}

function createRuntimeCssExpression({
  template,
  contextIdentifier,
}: {
  template: RuntimeCssTemplate,
  contextIdentifier: t.Identifier | undefined,
}): t.Expression {
  const occurrences = template.runtimeUrls.map((runtimeUrl) => {
    const index = template.css.indexOf(runtimeUrl.token);
    if (index === -1 || template.css.indexOf(runtimeUrl.token, index + runtimeUrl.token.length) !== -1) {
      throw new Error(`[${pluginName}] CSS URL placeholder ${runtimeUrl.token} must occur exactly once.`);
    }
    return { runtimeUrl, index };
  }).sort((left, right) => left.index - right.index);

  const parts: Array<string | t.Expression> = [];
  let lastIndex = 0;
  for (const { runtimeUrl, index } of occurrences) {
    parts.push(template.css.slice(lastIndex, index));
    if (contextIdentifier === undefined) {
      throw new Error(`[${pluginName}] System.register context parameter is required for CSS asset URLs.`);
    }
    parts.push(t.memberExpression(
      t.newExpression(t.identifier('URL'), [
        t.stringLiteral(runtimeUrl.relativeUrl),
        t.memberExpression(
          t.memberExpression(t.cloneNode(contextIdentifier), t.identifier('meta')),
          t.identifier('url'),
        ),
      ]),
      t.identifier('href'),
    ));
    lastIndex = index + runtimeUrl.token.length;
  }
  parts.push(template.css.slice(lastIndex));
  if (parts.length === 1 && typeof parts[0] === 'string') {
    return t.stringLiteral(parts[0]);
  }
  let expression: t.Expression = t.stringLiteral('');
  for (const part of parts) {
    expression = t.binaryExpression(
      '+',
      expression,
      typeof part === 'string' ? t.stringLiteral(part) : part,
    );
  }
  return expression;
}

function isSystemRegisterCall({ node }: { node: t.CallExpression }): boolean {
  return t.isMemberExpression(node.callee)
    && !node.callee.computed
    && t.isIdentifier(node.callee.object, { name: 'System' })
    && t.isIdentifier(node.callee.property, { name: 'register' });
}

function readObjectPropertyName({ property }: {
  property: t.ObjectMethod | t.ObjectProperty,
}): string | undefined {
  if (!property.computed && t.isIdentifier(property.key)) {
    return property.key.name;
  }
  if (t.isStringLiteral(property.key)) {
    return property.key.value;
  }
  return undefined;
}

function readReturnedObjectExpression({ argument }: {
  argument: t.Expression | null | undefined,
}): t.ObjectExpression | undefined {
  let expression = argument;
  while (t.isSequenceExpression(expression)) {
    expression = expression.expressions.at(-1);
  }
  return t.isObjectExpression(expression) ? expression : undefined;
}

function findSystemRegisterExecuteBody({ factory }: {
  factory: t.ArrowFunctionExpression | t.FunctionExpression,
}): t.BlockStatement | undefined {
  if (!t.isBlockStatement(factory.body)) {
    return undefined;
  }
  for (const statement of factory.body.body) {
    if (!t.isReturnStatement(statement)) {
      continue;
    }
    const returnedObject = readReturnedObjectExpression({ argument: statement.argument });
    if (returnedObject === undefined) {
      continue;
    }
    for (const property of returnedObject.properties) {
      if (!t.isObjectMethod(property) && !t.isObjectProperty(property)) {
        continue;
      }
      if (readObjectPropertyName({ property }) !== 'execute') {
        continue;
      }
      if (t.isObjectMethod(property)) {
        return property.body;
      }
      if (
        (t.isFunctionExpression(property.value) || t.isArrowFunctionExpression(property.value))
        && t.isBlockStatement(property.value.body)
      ) {
        return property.value.body;
      }
    }
  }
  return undefined;
}

function createCssInjectionStatements({
  cssAssets,
  contextIdentifier,
}: {
  cssAssets: readonly InlinedCssAsset[],
  contextIdentifier: t.Identifier | undefined,
}): t.Statement[] {
  return cssAssets.map((cssAsset) => {
    const identifierSuffix = cssAsset.styleId.replace(/[^A-Za-z\d_$]/gu, '_');
    const styleIdentifier = t.identifier(`__naidanFileProtocolStyle_${identifierSuffix}`);
    return t.ifStatement(
      t.binaryExpression(
        '===',
        t.callExpression(
          t.memberExpression(t.identifier('document'), t.identifier('getElementById')),
          [t.stringLiteral(cssAsset.styleId)],
        ),
        t.nullLiteral(),
      ),
      t.blockStatement([
        t.variableDeclaration('var', [
          t.variableDeclarator(
            styleIdentifier,
            t.callExpression(
              t.memberExpression(t.identifier('document'), t.identifier('createElement')),
              [t.stringLiteral('style')],
            ),
          ),
        ]),
        t.expressionStatement(t.assignmentExpression(
          '=',
          t.memberExpression(t.cloneNode(styleIdentifier), t.identifier('id')),
          t.stringLiteral(cssAsset.styleId),
        )),
        t.expressionStatement(t.callExpression(
          t.memberExpression(t.cloneNode(styleIdentifier), t.identifier('setAttribute')),
          [t.stringLiteral(inlinedCssAttribute), t.stringLiteral(cssAsset.fileName)],
        )),
        t.expressionStatement(t.assignmentExpression(
          '=',
          t.memberExpression(t.cloneNode(styleIdentifier), t.identifier('textContent')),
          createRuntimeCssExpression({ template: cssAsset.template, contextIdentifier }),
        )),
        t.expressionStatement(t.callExpression(
          t.memberExpression(
            t.memberExpression(t.identifier('document'), t.identifier('head')),
            t.identifier('appendChild'),
          ),
          [t.cloneNode(styleIdentifier)],
        )),
      ]),
    );
  });
}

function createSystemRegisterCssInjectionPlugin({ cssAssets, chunkFileName }: {
  cssAssets: readonly InlinedCssAsset[],
  chunkFileName: string,
}): PluginObj {
  let registerCallCount = 0;
  let injected = false;
  return {
    name: 'file-protocol-systemjs-css-injection',
    visitor: {
      CallExpression(babelPath) {
        if (!isSystemRegisterCall({ node: babelPath.node })) {
          return;
        }
        registerCallCount += 1;
        const factory = babelPath.node.arguments.at(-1);
        if (!t.isFunctionExpression(factory) && !t.isArrowFunctionExpression(factory)) {
          throw new Error(`[${pluginName}] ${chunkFileName} has an invalid System.register factory.`);
        }
        const executeBody = findSystemRegisterExecuteBody({ factory });
        if (executeBody === undefined) {
          throw new Error(`[${pluginName}] ${chunkFileName} has no System.register execute body.`);
        }
        const contextParameter = factory.params[1];
        const contextIdentifier = t.isIdentifier(contextParameter)
          ? contextParameter
          : undefined;
        executeBody.body.unshift(...createCssInjectionStatements({
          cssAssets,
          contextIdentifier,
        }));
        injected = true;
      },
    },
    post() {
      if (registerCallCount !== 1 || !injected) {
        throw new Error(
          `[${pluginName}] ${chunkFileName} must contain exactly one injectable System.register call; `
          + `found ${registerCallCount}.`,
        );
      }
    },
  };
}

function createCssStyleId({ fileName, source }: {
  fileName: string,
  source: string,
}): string {
  const digest = createHash('sha256')
    .update(fileName)
    .update('\0')
    .update(source)
    .digest('hex')
    .slice(0, 20);
  return `naidan-file-protocol-css-${digest}`;
}

function readChunkSourceMapInput({
  bundle,
  chunk,
  sourceMapMode,
}: {
  bundle: OutputBundle,
  chunk: OutputChunk,
  sourceMapMode: ResolvedConfig['build']['sourcemap'],
}): TransformOptions['inputSourceMap'] {
  if (sourceMapMode === false) {
    return undefined;
  }
  if (sourceMapMode === 'inline') {
    return readInlineSourceMap({ code: chunk.code, fileName: chunk.fileName });
  }
  const mapFileName = `${chunk.fileName}.map`;
  const mapOutput = bundle[mapFileName];
  const mapAsset = (() => {
    switch (mapOutput?.type) {
    case 'asset':
      return mapOutput;
    case 'chunk':
      throw new Error(`[${pluginName}] ${mapFileName} must be an asset, not a chunk.`);
    case undefined:
      throw new Error(`[${pluginName}] ${chunk.fileName} is missing emitted source map ${mapFileName}.`);
    default: {
      const _ex: never = mapOutput;
      throw new Error(`[${pluginName}] Unhandled source-map output: ${String(_ex)}`);
    }
    }
  })();
  const normalizedMap = normalizeSourceMap({ map: readAssetSource({ asset: mapAsset }) });
  if (normalizedMap === undefined) {
    throw new Error(`[${pluginName}] ${mapFileName} is empty.`);
  }
  return toBabelInputSourceMap({ map: normalizedMap, fileName: chunk.fileName });
}

function updateChunkSourceMap({
  bundle,
  chunk,
  map,
  sourceMapMode,
}: {
  bundle: OutputBundle,
  chunk: OutputChunk,
  map: unknown,
  sourceMapMode: ResolvedConfig['build']['sourcemap'],
}): void {
  if (sourceMapMode === false || sourceMapMode === 'inline') {
    return;
  }
  const normalizedMap = normalizeSourceMap({ map });
  if (normalizedMap === undefined) {
    throw new Error(`[${pluginName}] Babel returned no source map for ${chunk.fileName}.`);
  }
  normalizedMap.file = path.posix.basename(chunk.fileName);
  const mapFileName = `${chunk.fileName}.map`;
  const mapOutput = bundle[mapFileName];
  const mapAsset = (() => {
    switch (mapOutput?.type) {
    case 'asset':
      return mapOutput;
    case 'chunk':
      throw new Error(`[${pluginName}] ${mapFileName} became a chunk during CSS injection.`);
    case undefined:
      throw new Error(`[${pluginName}] ${chunk.fileName} source-map asset disappeared during CSS injection.`);
    default: {
      const _ex: never = mapOutput;
      throw new Error(`[${pluginName}] Unhandled source-map output: ${String(_ex)}`);
    }
    }
  })();
  mapAsset.source = JSON.stringify(normalizedMap);
}

async function injectCssAssetsIntoChunk({
  bundle,
  chunk,
  cssAssets,
  sourceMapMode,
  shouldCompact,
}: {
  bundle: OutputBundle,
  chunk: OutputChunk,
  cssAssets: readonly InlinedCssAsset[],
  sourceMapMode: ResolvedConfig['build']['sourcemap'],
  shouldCompact: boolean,
}): Promise<void> {
  const result = await transformAsync(stripSourceMapComments({ code: chunk.code }), {
    filename: chunk.fileName,
    babelrc: false,
    configFile: false,
    ast: false,
    code: true,
    cloneInputAst: false,
    compact: shouldCompact,
    minified: shouldCompact,
    comments: true,
    sourceType: 'script',
    sourceMaps: sourceMapMode === 'inline' ? 'inline' : Boolean(sourceMapMode),
    inputSourceMap: readChunkSourceMapInput({ bundle, chunk, sourceMapMode }),
    plugins: [createSystemRegisterCssInjectionPlugin({
      cssAssets,
      chunkFileName: chunk.fileName,
    })],
  });
  if (result?.code === undefined || result.code === null) {
    throw new Error(`[${pluginName}] Babel returned no CSS-injected code for ${chunk.fileName}.`);
  }
  chunk.code = sourceMapMode === true
    ? `${result.code}\n//# sourceMappingURL=${path.posix.basename(chunk.fileName)}.map`
    : result.code;
  updateChunkSourceMap({
    bundle,
    chunk,
    map: result.map,
    sourceMapMode,
  });
}

function removeInlinedStylesheetLinks({
  bundle,
  inlinedCssFileNames,
}: {
  bundle: OutputBundle,
  inlinedCssFileNames: ReadonlySet<string>,
}): void {
  for (const output of Object.values(bundle)) {
    if (output.type !== 'asset' || !output.fileName.endsWith('.html')) {
      continue;
    }
    const dom = new JSDOM(readAssetSource({ asset: output }));
    const stylesheetLinks = Array.from(dom.window.document.querySelectorAll('link[rel]'))
      .filter((link) => (link.getAttribute('rel') ?? '')
        .split(/\s+/u)
        .some((token) => token.toLowerCase() === 'stylesheet'));
    for (const link of stylesheetLinks) {
      const href = link.getAttribute('href');
      if (href === null) {
        throw new Error(`[${pluginName}] Stylesheet link in ${output.fileName} is missing href.`);
      }
      const fileName = parseRelativeOutputFileName({
        value: href,
        attribute: 'stylesheet href',
      });
      if (!inlinedCssFileNames.has(fileName)) {
        throw new Error(
          `[${pluginName}] External stylesheet ${fileName} is not owned by an application chunk.`,
        );
      }
      link.remove();
    }
    output.source = dom.serialize();
  }
}

function removeInlinedCssFromViteManifest({
  bundle,
  manifestFileName,
  inlinedCssFileNames,
}: {
  bundle: OutputBundle,
  manifestFileName: string | undefined,
  inlinedCssFileNames: ReadonlySet<string>,
}): void {
  if (manifestFileName === undefined) {
    return;
  }
  const output = bundle[manifestFileName];
  const manifestAsset = (() => {
    switch (output?.type) {
    case 'asset':
      return output;
    case 'chunk':
      throw new Error(`[${pluginName}] Vite manifest ${manifestFileName} must be an asset.`);
    case undefined:
      throw new Error(`[${pluginName}] Vite manifest ${manifestFileName} was not emitted.`);
    default: {
      const _ex: never = output;
      throw new Error(`[${pluginName}] Unhandled Vite manifest output: ${String(_ex)}`);
    }
    }
  })();
  const parsed = readJsonAsset({ asset: manifestAsset, fileName: manifestFileName });
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[${pluginName}] Vite manifest ${manifestFileName} must contain an object.`);
  }
  const manifest = parsed as Record<string, unknown>;
  for (const [moduleId, value] of Object.entries(manifest)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`[${pluginName}] Vite manifest entry ${moduleId} must contain an object.`);
    }
    const entry = value as Record<string, unknown>;
    const css = entry.css;
    if (css === undefined) {
      continue;
    }
    if (!Array.isArray(css) || css.some((fileName) => typeof fileName !== 'string')) {
      throw new Error(`[${pluginName}] Vite manifest entry ${moduleId} has an invalid css list.`);
    }
    const unexpectedCss = (css as string[])
      .filter((fileName) => !inlinedCssFileNames.has(fileName));
    if (unexpectedCss.length > 0) {
      throw new Error(
        `[${pluginName}] Vite manifest entry ${moduleId} references non-inlined CSS: ${unexpectedCss.join(', ')}.`,
      );
    }
    delete entry.css;
  }
  manifestAsset.source = `${JSON.stringify(manifest, undefined, 2)}\n`;
}

function resolveViteManifestFileName({ manifest }: {
  manifest: ResolvedConfig['build']['manifest'],
}): string | undefined {
  if (manifest === false) {
    return undefined;
  }
  if (manifest === true) {
    return '.vite/manifest.json';
  }
  return manifest;
}

/** @internal Exported for focused plugin tests. */
export function assertSupportedFileProtocolSystemJsConfig({ config }: {
  config: ResolvedConfig,
}): void {
  if (config.base !== './' && config.base !== '') {
    throw new Error(`[${pluginName}] Vite base must be './' or '' for file:// output; received ${JSON.stringify(config.base)}.`);
  }
  if (config.build.modulePreload !== false) {
    throw new Error(`[${pluginName}] build.modulePreload must be false so no fetch-based preload runtime is emitted.`);
  }
  if (config.build.cssCodeSplit !== true) {
    throw new Error(`[${pluginName}] build.cssCodeSplit must be true so lazy CSS ownership remains explicit.`);
  }
  if (config.build.ssr) {
    throw new Error(`[${pluginName}] SSR builds are unsupported.`);
  }
  if (config.build.lib) {
    throw new Error(`[${pluginName}] Library mode is unsupported; an HTML application entry is required.`);
  }
  if (config.build.write === false) {
    throw new Error(`[${pluginName}] build.write=false is unsupported because final output must be validated.`);
  }
  if (config.build.minify !== false && config.build.minify !== 'oxc') {
    throw new Error(`[${pluginName}] build.minify must be false or 'oxc'; received ${JSON.stringify(config.build.minify)}.`);
  }
  const pluginInstances = config.plugins.filter((plugin) => plugin.name === pluginName).length;
  if (pluginInstances !== 1) {
    throw new Error(`[${pluginName}] Expected exactly one plugin instance; found ${pluginInstances}.`);
  }
}

/** @internal Exported for focused plugin tests. */
export function collectFileProtocolSystemJsOutputReferences({ chunk }: {
  chunk: OutputChunk,
}): readonly string[] {
  return [...new Set([
    ...chunk.imports,
    ...chunk.dynamicImports,
    ...chunk.viteMetadata?.importedAssets ?? [],
    ...chunk.viteMetadata?.importedCss ?? [],
  ])].sort();
}

function readJsonAsset({ asset, fileName }: {
  asset: OutputAsset,
  fileName: string,
}): unknown {
  const source = readAssetSource({ asset });
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${pluginName}] ${fileName} is not valid JSON: ${message}.`);
  }
}

function readStringArray({ value, label }: {
  value: unknown,
  label: string,
}): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`[${pluginName}] ${label} must be an array of strings.`);
  }
  return value as readonly string[];
}

/** @internal Exported for focused plugin tests. */
export function validateFileProtocolSystemJsSourceMap({ bundle, chunk }: {
  bundle: OutputBundle,
  chunk: OutputChunk,
}): Readonly<{
  sourceMapFileName: string,
  sourceMapSources: number,
}> {
  const mapFileName = `${chunk.fileName}.map`;
  const mapOutput = bundle[mapFileName];
  const mapAsset = (() => {
    switch (mapOutput?.type) {
    case 'asset':
      return mapOutput;
    case 'chunk':
      throw new Error(`[${pluginName}] ${mapFileName} must be an asset, not a chunk.`);
    case undefined:
      throw new Error(`[${pluginName}] ${chunk.fileName} is missing emitted source map ${mapFileName}.`);
    default: {
      const _ex: never = mapOutput;
      throw new Error(`[${pluginName}] Unhandled source-map output: ${String(_ex)}`);
    }
    }
  })();
  const map = readJsonAsset({ asset: mapAsset, fileName: mapFileName });
  if (typeof map !== 'object' || map === null) {
    throw new Error(`[${pluginName}] ${mapFileName} must contain a source-map object.`);
  }
  const record = map as Record<string, unknown>;
  if (record.version !== 3) {
    throw new Error(`[${pluginName}] ${mapFileName} must use source map version 3.`);
  }
  const sources = readStringArray({ value: record.sources, label: `${mapFileName} sources` });
  if (sources.length === 0) {
    throw new Error(`[${pluginName}] ${mapFileName} has no sources.`);
  }
  const sourcesContent = readStringArray({ value: record.sourcesContent, label: `${mapFileName} sourcesContent` });
  if (sourcesContent.length !== sources.length) {
    throw new Error(`[${pluginName}] ${mapFileName} must embed sourcesContent for every source.`);
  }
  if (record.file !== chunk.fileName.split('/').at(-1)) {
    throw new Error(`[${pluginName}] ${mapFileName} has unexpected file field ${JSON.stringify(record.file)}.`);
  }
  if (typeof record.mappings !== 'string' || record.mappings.length === 0) {
    throw new Error(`[${pluginName}] ${mapFileName} has no mappings.`);
  }
  return {
    sourceMapFileName: mapFileName,
    sourceMapSources: sources.length,
  };
}

/**
 * Convert Vite's split ESM output to split System.register chunks for file://.
 *
 * Naidan can also support file:// through @vitejs/plugin-legacy's SystemJS
 * output. This dedicated plugin is not required merely to make file:// loading
 * possible. It exists to avoid the generic legacy-browser processing and
 * Terser-based minification used by that path, reducing build time and memory
 * usage for Naidan's large split-chunk graph while preserving the established
 * SystemJS runtime, lazy chunks, and lazy CSS behavior.
 *
 * Babel is intentionally used as the reference ESM-to-System.register
 * transform. SWC has had a SystemJS live-binding correctness issue, so it must
 * not replace Babel here without independent semantic-equivalence validation:
 * https://github.com/swc-project/swc/issues/4895
 *
 * Vite normally emits split CSS files for ES chunks. The plugin explicitly
 * moves each finalized CSS asset into its owning System.register execute body,
 * including runtime URL resolution against the chunk URL. This avoids relying
 * on @vitejs/plugin-legacy's filename marker while preserving lazy CSS timing.
 *
 * Syntax lowering beyond module conversion remains Vite/Rolldown's concern.
 */
export function fileProtocolSystemJs({ diagnostics }: FileProtocolSystemJsOptions): Plugin {
  let manifestFileName: string | undefined;
  let sourceMapMode: ResolvedConfig['build']['sourcemap'] = false;
  let shouldCompact = false;
  let timing = createEmptyTiming();

  return {
    name: pluginName,
    enforce: 'post',
    apply: 'build',
    configResolved(config) {
      assertSupportedFileProtocolSystemJsConfig({ config });
      manifestFileName = resolveViteManifestFileName({ manifest: config.build.manifest });
      sourceMapMode = config.build.sourcemap;
      shouldCompact = config.build.minify === 'oxc';
    },
    buildStart() {
      timing = createEmptyTiming();
    },
    async renderChunk(raw, chunk: RenderedChunk) {
      const started = performance.now();
      const sourceMaps = Boolean(sourceMapMode);
      const renderContext = this as typeof this & Partial<{ getCombinedSourcemap(): SourceMap }>;
      const inputMap = sourceMaps && typeof renderContext.getCombinedSourcemap === 'function'
        ? normalizeSourceMap({ map: renderContext.getCombinedSourcemap() })
        : undefined;
      const result = await transformAsync(raw, {
        filename: chunk.fileName,
        babelrc: false,
        configFile: false,
        ast: false,
        code: true,
        cloneInputAst: false,
        compact: false,
        comments: true,
        sourceMaps,
        inputSourceMap: inputMap as Exclude<TransformOptions['inputSourceMap'], boolean | null | undefined> | undefined,
        plugins: [transformDynamicImport, transformModulesSystemjs],
      });
      timing.babelMs += performance.now() - started;
      if (result?.code === undefined || result.code === null) {
        throw new Error(`[${pluginName}] Babel returned no code for ${chunk.fileName}.`);
      }
      timing.chunks += 1;
      timing.inputBytes += Buffer.byteLength(raw);
      timing.outputBytesBeforeMinify += Buffer.byteLength(result.code);
      return {
        code: result.code,
        map: normalizeSourceMap({ map: result.map }) as SourceMapInput,
      };
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk');
        const inlinedCssFileNames = new Set<string>();
        const cssDiagnostics = new Map<string, readonly Readonly<{
          fileName: string,
          bytes: number,
          styleId: string,
          runtimeUrlCount: number,
        }>[]>();

        for (const chunk of chunks) {
          const chunkBaseName = path.posix.basename(chunk.fileName);
          if (!chunkBaseName.includes(systemJsChunkMarker)) {
            throw new Error(
              `[${pluginName}] Application chunk ${chunk.fileName} must use the ${systemJsChunkMarker} marker.`,
            );
          }
          if (chunk.fileName.includes(legacyChunkMarker)) {
            throw new Error(`[${pluginName}] Legacy chunk marker remains in ${chunk.fileName}.`);
          }
          const cssFileNames = [...chunk.viteMetadata?.importedCss ?? []];
          const cssAssets = cssFileNames.map((fileName): InlinedCssAsset => {
            const output = bundle[fileName];
            const asset = (() => {
              switch (output?.type) {
              case 'asset':
                return output;
              case 'chunk':
                throw new Error(`[${pluginName}] ${chunk.fileName} CSS reference ${fileName} is a chunk.`);
              case undefined:
                throw new Error(`[${pluginName}] ${chunk.fileName} references missing CSS asset ${fileName}.`);
              default: {
                const _ex: never = output;
                throw new Error(`[${pluginName}] Unhandled CSS output: ${String(_ex)}`);
              }
              }
            })();
            const source = readAssetSource({ asset });
            const template = createFileProtocolSystemJsRuntimeCssTemplate({
              source,
              cssFileName: fileName,
              chunkFileName: chunk.fileName,
            });
            return {
              fileName,
              source,
              styleId: createCssStyleId({ fileName, source }),
              template,
            };
          });
          if (cssAssets.length > 0) {
            const started = performance.now();
            await injectCssAssetsIntoChunk({
              bundle,
              chunk,
              cssAssets,
              sourceMapMode,
              shouldCompact,
            });
            timing.cssInjectionMs += performance.now() - started;
            timing.cssAssets += cssAssets.length;
            timing.cssInputBytes += cssAssets.reduce((total, asset) => total + Buffer.byteLength(asset.source), 0);
            cssDiagnostics.set(chunk.fileName, cssAssets.map((asset) => ({
              fileName: asset.fileName,
              bytes: Buffer.byteLength(asset.source),
              styleId: asset.styleId,
              runtimeUrlCount: asset.template.runtimeUrls.length,
            })));
            for (const cssAsset of cssAssets) {
              inlinedCssFileNames.add(cssAsset.fileName);
            }
            chunk.viteMetadata?.importedCss.clear();
          }
        }

        const emittedCssFileNames = Object.entries(bundle)
          .filter(([, item]) => item.type === 'asset' && item.fileName.endsWith('.css'))
          .map(([fileName]) => fileName);
        const unownedCssFileNames = emittedCssFileNames
          .filter((fileName) => !inlinedCssFileNames.has(fileName));
        if (unownedCssFileNames.length > 0) {
          throw new Error(
            `[${pluginName}] CSS assets are not owned by an application chunk: ${unownedCssFileNames.join(', ')}.`,
          );
        }
        removeInlinedStylesheetLinks({ bundle, inlinedCssFileNames });
        removeInlinedCssFromViteManifest({
          bundle,
          manifestFileName,
          inlinedCssFileNames,
        });
        for (const fileName of inlinedCssFileNames) {
          delete bundle[fileName];
        }

        const emittedNames = new Set(Object.keys(bundle));
        const chunkDiagnostics = [];
        for (const chunk of chunks) {
          const validation = assertFileProtocolStandaloneClassicScript({
            source: chunk.code,
            label: chunk.fileName,
            mode: 'application-chunk',
          });
          if (validation.systemRegisterCallCount !== 1) {
            throw new Error(
              `[${pluginName}] ${chunk.fileName} must contain exactly one System.register call; `
              + `found ${validation.systemRegisterCallCount}.`,
            );
          }
          const references = collectFileProtocolSystemJsOutputReferences({ chunk });
          for (const reference of references) {
            if (!emittedNames.has(reference)) {
              throw new Error(`[${pluginName}] ${chunk.fileName} references missing emitted file ${reference}.`);
            }
          }
          const sourceMap = sourceMapMode === true || sourceMapMode === 'hidden'
            ? validateFileProtocolSystemJsSourceMap({ bundle, chunk })
            : sourceMapMode === 'inline'
              ? (() => {
                if (!/sourceMappingURL=data:application\/json/u.test(chunk.code)) {
                  throw new Error(`[${pluginName}] ${chunk.fileName} is missing inline source map.`);
                }
                return { sourceMapFileName: undefined, sourceMapSources: undefined };
              })()
              : { sourceMapFileName: undefined, sourceMapSources: undefined };
          chunkDiagnostics.push({
            fileName: chunk.fileName,
            bytes: Buffer.byteLength(chunk.code),
            isEntry: chunk.isEntry,
            isDynamicEntry: chunk.isDynamicEntry,
            imports: [...chunk.imports],
            dynamicImports: [...chunk.dynamicImports],
            allReferences: references,
            inlinedCss: cssDiagnostics.get(chunk.fileName) ?? [],
            moduleIds: Object.keys(chunk.modules).sort(),
            systemRegisterCallCount: validation.systemRegisterCallCount,
            ...sourceMap,
          });
        }
        if (chunks.length === 0) {
          throw new Error(`[${pluginName}] No JavaScript chunks were emitted.`);
        }
        switch (diagnostics) {
        case 'omit':
          return;
        case 'emit':
          break;
        default: {
          const unhandledDiagnostics: never = diagnostics;
          throw new Error(
            `[${pluginName}] Unhandled diagnostics mode: ${String(unhandledDiagnostics)}`,
          );
        }
        }
        this.emitFile({
          type: 'asset',
          fileName: 'systemjs-output-contract.json',
          source: `${JSON.stringify({
            format: 'file-protocol-systemjs-output-contract-v2',
            chunks: chunkDiagnostics.sort((left, right) => left.fileName.localeCompare(right.fileName)),
          }, undefined, 2)}\n`,
        });
        this.emitFile({
          type: 'asset',
          fileName: 'systemjs-transform-timing.json',
          source: `${JSON.stringify({
            format: 'file-protocol-systemjs-transform-timing-v2',
            ...timing,
          }, undefined, 2)}\n`,
        });
      },
    },
  };
}
