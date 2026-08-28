import { Buffer } from 'node:buffer';
import path from 'node:path';
import type { OutputAsset, OutputChunk } from 'rolldown';
import type { StandaloneBuildDiagnostics } from './diagnostics.js';
import {
  assertFileProtocolStandaloneHtmlAfterRewrite,
  assertFileProtocolStandaloneHtmlBeforeRewrite,
  resolveFileProtocolStandaloneHtmlReference,
  type FileProtocolStandaloneHtmlSourceRange,
} from '../html-validation.js';
import { insertFileProtocolStandaloneBootstrap } from '../html-output.js';
import { FILE_PROTOCOL_STANDALONE_ELEMENT_IDS } from '../../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';
import { createFileProtocolStandaloneEntryBootstrapSource } from '../file-protocol-startup-support.js';

function slash(value: string): string {
  return value.split(path.sep).join('/');
}

function collectUiStylesheetFileNamesInViteOrder({
  chunkByFileName,
  entryFileName,
  traversal,
}: Readonly<{
  chunkByFileName: ReadonlyMap<string, OutputChunk>;
  entryFileName: string;
  traversal: 'static-closure' | 'complete-ui-closure';
}>): string[] {
  const visitedChunks = new Set<string>();
  const seenCss = new Set<string>();
  const orderedCss: string[] = [];
  const pendingDynamicImports: string[] = [];

  const visitStaticClosure = ({ fileName }: Readonly<{fileName: string}>): void => {
    if (visitedChunks.has(fileName)) return;
    visitedChunks.add(fileName);
    const chunk = chunkByFileName.get(fileName);
    if (chunk === undefined) {
      throw new Error(`UI chunk graph references a missing emitted chunk: ${fileName}`);
    }

    // Match Vite's CSS cascade order: static imports are traversed depth-first
    // before the importing chunk's own importedCss Set. Dynamic branches are
    // visited only when validating the complete UI closure; initial HTML must
    // contain only the static closure so lazy CSS keeps its import-time semantics.
    for (const importedFileName of chunk.imports) visitStaticClosure({ fileName: importedFileName });

    const importedCss = chunk.viteMetadata?.importedCss;
    if (importedCss === undefined) {
      throw new Error(`Missing Vite importedCss metadata for ${fileName}`);
    }
    if (!(importedCss instanceof Set)) {
      throw new Error(`Unexpected Vite importedCss metadata shape for ${fileName}`);
    }
    for (const cssFileName of importedCss) {
      if (typeof cssFileName !== 'string') {
        throw new Error(`Unexpected Vite importedCss metadata entry for ${fileName}: ${String(cssFileName)}`);
      }
      if (!seenCss.has(cssFileName)) {
        seenCss.add(cssFileName);
        orderedCss.push(cssFileName);
      }
    }

    switch (traversal) {
    case 'static-closure':
      break;
    case 'complete-ui-closure':
      pendingDynamicImports.push(...chunk.dynamicImports);
      break;
    default: {
      const _ex: never = traversal;
      throw new Error(`Unhandled UI stylesheet traversal: ${_ex}`);
    }
    }
  };

  visitStaticClosure({ fileName: entryFileName });
  for (let index = 0; index < pendingDynamicImports.length; index += 1) {
    const dynamicImport = pendingDynamicImports[index];
    if (dynamicImport !== undefined) visitStaticClosure({ fileName: dynamicImport });
  }

  return orderedCss;
}

function localHtmlReferenceToBundleFileName(reference: string, htmlFileName: string): string {
  return resolveFileProtocolStandaloneHtmlReference({
    reference,
    htmlFileName,
    attribute: 'HTML reference',
  });
}

function bundleFileNameToHtmlReference({ fileName, htmlFileName }: Readonly<{
  fileName: string;
  htmlFileName: string;
}>): string {
  const relative = slash(path.posix.relative(path.posix.dirname(htmlFileName), fileName));
  // Rollup file names are output paths, while href/src values are URLs. Encode each
  // path segment so a valid asset name containing spaces, %, #, ?, or non-ASCII
  // characters cannot change URL semantics when written into standalone HTML.
  const encodedRelative = relative.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return encodedRelative.startsWith('.') ? encodedRelative : `./${encodedRelative}`;
}


function sortedValidatedHtmlSourceRanges({
  html,
  ranges,
}: Readonly<{
  html: string;
  ranges: readonly FileProtocolStandaloneHtmlSourceRange[];
}>): readonly FileProtocolStandaloneHtmlSourceRange[] {
  const sorted = [...ranges].sort((left, right) => right.startOffset - left.startOffset);
  let previousStart = html.length;
  for (const range of sorted) {
    if (
      !Number.isInteger(range.startOffset)
      || !Number.isInteger(range.endOffset)
      || range.startOffset < 0
      || range.endOffset <= range.startOffset
      || range.endOffset > previousStart
    ) {
      throw new Error('Invalid or overlapping standalone HTML source range');
    }
    previousStart = range.startOffset;
  }
  return sorted;
}

function removeHtmlSourceRanges({
  html,
  ranges,
}: Readonly<{
  html: string;
  ranges: readonly FileProtocolStandaloneHtmlSourceRange[];
}>): string {
  let rewritten = html;
  for (const range of sortedValidatedHtmlSourceRanges({ html, ranges })) {
    rewritten = `${rewritten.slice(0, range.startOffset)}${rewritten.slice(range.endOffset)}`;
  }
  return rewritten;
}

type StandaloneHtmlRewritePlan = Readonly<{
  sourceRangesToRemove: readonly FileProtocolStandaloneHtmlSourceRange[];
  applicationEntrySource: string;
  uiPreloadedCssFileNames: readonly string[];
  uiPreloadedCssUrls: readonly string[];
  systemRuntimeUrl: string;
  systemJsFileScriptLoaderPatchUrl: string;
  systemJsRetryHookUrl: string;
  entryBootstrap: string;
}>;

function createStandaloneHtmlRewritePlan({
  html,
  htmlFileName,
  outputByFileName,
  chunkByFileName,
  systemRuntimeFileName,
  systemJsFileScriptLoaderPatchFileName,
  systemJsRetryHookFileName,
  startupSlowNoticeDelayMs,
  effectFreeEmptyCssFileNames,
}: Readonly<{
  html: string;
  htmlFileName: string;
  outputByFileName: ReadonlyMap<string, OutputAsset | OutputChunk>;
  chunkByFileName: ReadonlyMap<string, OutputChunk>;
  systemRuntimeFileName: string;
  systemJsFileScriptLoaderPatchFileName: string;
  systemJsRetryHookFileName: string;
  startupSlowNoticeDelayMs: number;
  effectFreeEmptyCssFileNames: ReadonlySet<string>;
}>): StandaloneHtmlRewritePlan {
  const {
    stylesheetReferences,
    applicationEntry,
  } = assertFileProtocolStandaloneHtmlBeforeRewrite({
    html,
    htmlFileName,
  });
  // The validator already parses HTML with JSDOM. Reuse its source locations
  // instead of reparsing attributes with regexes, otherwise valid HTML syntax
  // such as unquoted attributes can pass validation but fail during rewriting.
  const prunedStylesheetReferences = stylesheetReferences.filter(({ fileName }) => (
    effectFreeEmptyCssFileNames.has(fileName)
  ));
  const stylesheetCrossoriginRangesToRemove = stylesheetReferences
    .filter(({ fileName }) => !effectFreeEmptyCssFileNames.has(fileName))
    .flatMap(({ crossoriginAttributeRange }) => (
      crossoriginAttributeRange === undefined ? [] : [crossoriginAttributeRange]
    ));
  const sourceRangesToRemove = [
    applicationEntry,
    ...prunedStylesheetReferences,
    ...stylesheetCrossoriginRangesToRemove,
  ];
  // Preserve the original failure point before later graph planning. apply runs
  // immediately after this plan is created, so these offsets always refer to the
  // same original HTML string.
  sortedValidatedHtmlSourceRanges({ html, ranges: sourceRangesToRemove });

  const effectiveStylesheetReferences = stylesheetReferences
    .filter(({ fileName }) => !effectFreeEmptyCssFileNames.has(fileName));
  const existingStylesheetFileNameList = effectiveStylesheetReferences
    .filter(({ unconditional }) => unconditional)
    .map(({ fileName }) => fileName);
  const moduleEntryFileName = localHtmlReferenceToBundleFileName(applicationEntry.source, htmlFileName);
  if (!chunkByFileName.has(moduleEntryFileName)) {
    throw new Error(`HTML module entry does not resolve to an emitted chunk: ${applicationEntry.source} in ${htmlFileName}`);
  }
  const existingStylesheetFileNames = new Set(existingStylesheetFileNameList);
  // Vite owns lazy CSS timing through Dynamic Import preload metadata. Keep
  // only the entry/static CSS closure in initial HTML; dynamic-only CSS must
  // remain absent until the corresponding module is requested.
  const initialUiCssFileNames = collectUiStylesheetFileNamesInViteOrder({
    chunkByFileName,
    entryFileName: moduleEntryFileName,
    traversal: 'static-closure',
  });
  const completeUiCssFileNames = collectUiStylesheetFileNamesInViteOrder({
    chunkByFileName,
    entryFileName: moduleEntryFileName,
    traversal: 'complete-ui-closure',
  });
  for (const cssFileName of completeUiCssFileNames) {
    const cssOutput = outputByFileName.get(cssFileName);
    if (cssOutput?.type !== 'asset' || !/\.css$/iu.test(cssOutput.fileName)) {
      throw new Error(`UI stylesheet metadata references a missing output asset: ${cssFileName}`);
    }
  }
  const completeUiCssFileNameSet = new Set(completeUiCssFileNames);
  const initialUiCssFileNameSet = new Set(initialUiCssFileNames);
  const dynamicOnlyUiCssFileNameSet = new Set(
    completeUiCssFileNames.filter(fileName => !initialUiCssFileNameSet.has(fileName)),
  );
  const prematurelyLinkedDynamicCss = existingStylesheetFileNameList
    .filter(fileName => dynamicOnlyUiCssFileNameSet.has(fileName));
  if (prematurelyLinkedDynamicCss.length > 0) {
    throw new Error(`Dynamic-only UI stylesheets must not be linked from initial HTML: ${prematurelyLinkedDynamicCss.join(', ')}`);
  }
  const invalidExistingUiStylesheets = effectiveStylesheetReferences
    .filter(({ fileName, unconditional, inHead }) => completeUiCssFileNameSet.has(fileName) && (!unconditional || !inHead))
    .map(({ fileName }) => fileName);
  if (invalidExistingUiStylesheets.length > 0) {
    throw new Error(`UI-owned stylesheet links must apply unconditionally from <head>: ${invalidExistingUiStylesheets.join(', ')}`);
  }
  const existingUiCssFileNames = existingStylesheetFileNameList
    .filter(fileName => initialUiCssFileNameSet.has(fileName));
  const expectedExistingUiCssPrefix = initialUiCssFileNames.slice(0, existingUiCssFileNames.length);
  if (existingUiCssFileNames.some((fileName, index) => fileName !== expectedExistingUiCssPrefix[index])) {
    throw new Error(
      `Existing UI stylesheet order does not match the Vite cascade prefix: expected ${JSON.stringify(expectedExistingUiCssPrefix)}, got ${JSON.stringify(existingUiCssFileNames)}`,
    );
  }
  const uiPreloadedCssFileNames = initialUiCssFileNames
    .filter(fileName => !existingStylesheetFileNames.has(fileName));
  const uiPreloadedCssUrls = uiPreloadedCssFileNames.map(fileName => (
    bundleFileNameToHtmlReference({ fileName, htmlFileName })
  ));

  const systemRuntimeUrl = bundleFileNameToHtmlReference({ fileName: systemRuntimeFileName, htmlFileName });
  const systemJsFileScriptLoaderPatchUrl = bundleFileNameToHtmlReference({
    fileName: systemJsFileScriptLoaderPatchFileName,
    htmlFileName,
  });
  const systemJsRetryHookUrl = bundleFileNameToHtmlReference({ fileName: systemJsRetryHookFileName, htmlFileName });
  const entryReference = bundleFileNameToHtmlReference({ fileName: moduleEntryFileName, htmlFileName });
  const entryBootstrap = createFileProtocolStandaloneEntryBootstrapSource({
    entryFileName: entryReference.replace(/^\.\//u, ''),
    slowStartupNoticeDelayMs: startupSlowNoticeDelayMs,
  });

  return {
    sourceRangesToRemove,
    applicationEntrySource: applicationEntry.source,
    uiPreloadedCssFileNames,
    uiPreloadedCssUrls,
    systemRuntimeUrl,
    systemJsFileScriptLoaderPatchUrl,
    systemJsRetryHookUrl,
    entryBootstrap,
  };
}

function applyStandaloneHtmlRewrite({
  html,
  htmlFileName,
  plan,
}: Readonly<{
  html: string;
  htmlFileName: string;
  plan: StandaloneHtmlRewritePlan;
}>): string {
  const rewrittenWithoutGeneratedInputs = removeHtmlSourceRanges({
    html,
    ranges: plan.sourceRangesToRemove,
  });
  const cssLinks = plan.uiPreloadedCssUrls
    .map(url => `<link rel="stylesheet" href=${JSON.stringify(url)}>`)
    .join('');
  // This is the one proven UI loading path. SystemJS appends only requested
  // Classic Scripts; the external patch removes crossorigin only for file: URLs.
  // Keeping one path avoids carrying historical fallback loaders into Naidan.
  const bootstrap = `${cssLinks}`
    + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime)} src=${JSON.stringify(plan.systemRuntimeUrl)}></script>`
    + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch)} src=${JSON.stringify(plan.systemJsFileScriptLoaderPatchUrl)}></script>`
    + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook)} src=${JSON.stringify(plan.systemJsRetryHookUrl)}></script>`
    + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap)}>${plan.entryBootstrap}</script>`;
  const rewrittenHtml = insertFileProtocolStandaloneBootstrap({
    html: rewrittenWithoutGeneratedInputs,
    bootstrap,
  });
  assertFileProtocolStandaloneHtmlAfterRewrite({ html: rewrittenHtml, htmlFileName });
  return rewrittenHtml;
}

export function rewriteStandaloneHtml({
  output,
  outputByFileName,
  chunkByFileName,
  systemRuntimeFileName,
  systemJsFileScriptLoaderPatchFileName,
  systemJsRetryHookFileName,
  startupSlowNoticeDelayMs,
  effectFreeEmptyCssFileNames,
  diagnostics,
}: Readonly<{
  output: OutputAsset;
  outputByFileName: ReadonlyMap<string, OutputAsset | OutputChunk>;
  chunkByFileName: ReadonlyMap<string, OutputChunk>;
  systemRuntimeFileName: string;
  systemJsFileScriptLoaderPatchFileName: string;
  systemJsRetryHookFileName: string;
  startupSlowNoticeDelayMs: number;
  effectFreeEmptyCssFileNames: ReadonlySet<string>;
  diagnostics: StandaloneBuildDiagnostics;
}>): void {
  const html = typeof output.source === 'string'
    ? output.source
    : Buffer.from(output.source).toString('utf8');
  const plan = createStandaloneHtmlRewritePlan({
    html,
    htmlFileName: output.fileName,
    outputByFileName,
    chunkByFileName,
    systemRuntimeFileName,
    systemJsFileScriptLoaderPatchFileName,
    systemJsRetryHookFileName,
    startupSlowNoticeDelayMs,
    effectFreeEmptyCssFileNames,
  });
  output.source = applyStandaloneHtmlRewrite({
    html,
    htmlFileName: output.fileName,
    plan,
  });
  diagnostics.html.push({
    fileName: output.fileName,
    moduleEntryUrls: [plan.applicationEntrySource],
    systemRuntimeUrl: plan.systemRuntimeUrl,
    uiPreloadedCssFileNames: [...plan.uiPreloadedCssFileNames],
    uiPreloadedCssUrls: [...plan.uiPreloadedCssUrls],
    startupScriptElementIds: [
      FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime,
      FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch,
      FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook,
      FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap,
    ],
  });
}
