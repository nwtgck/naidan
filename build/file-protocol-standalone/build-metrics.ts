import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import type { OutputAsset, OutputBundle, OutputChunk } from 'rolldown';

import { parseRelativeOutputFileName } from './html-output';
import type {
  FileProtocolStandaloneBuildMetrics,
  FileProtocolStandaloneBuildMetricsPlan,
  FileProtocolStandaloneBudgets,
  FileProtocolStandaloneInitialRequestDescriptor,
} from './types';

const pluginName = 'file-protocol-standalone';

export function utf8ByteLength({ source }: { source: string }): number {
  return Buffer.byteLength(source, 'utf8');
}

export function resolveFileProtocolStandaloneOutputPath({ outputDirectory, fileName }: {
  outputDirectory: string,
  fileName: string,
}): string {
  const outputPath = path.resolve(outputDirectory, fileName);
  const relative = path.relative(outputDirectory, outputPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[${pluginName}] Output file escapes build.outDir: ${fileName}`);
  }
  return outputPath;
}

export function collectStaticChunkClosure({ entryFileName, chunksByName }: {
  entryFileName: string,
  chunksByName: ReadonlyMap<string, OutputChunk>,
}): string[] {
  const visited = new Set<string>();
  const queue = [entryFileName];
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (fileName === undefined || visited.has(fileName)) {
      continue;
    }
    visited.add(fileName);
    const chunk = chunksByName.get(fileName);
    if (chunk !== undefined) {
      queue.push(...chunk.imports);
    }
  }
  return [...visited].sort();
}

export function readBundleItemByteLength({ item }: {
  item: OutputChunk | OutputAsset,
}): number {
  switch (item.type) {
  case 'chunk':
    return utf8ByteLength({ source: item.code });
  case 'asset':
    return typeof item.source === 'string'
      ? utf8ByteLength({ source: item.source })
      : item.source.byteLength;
  default: {
    const _exhaustive: never = item;
    throw new Error(`Unhandled bundle item type: ${((_exhaustive satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function collectInitialStylesheetFileNames({ bundle }: {
  bundle: OutputBundle,
}): string[] {
  const htmlAsset = Object.values(bundle).find((item): item is OutputAsset => item.type === 'asset' && item.fileName === 'index.html');
  if (htmlAsset === undefined) {
    throw new Error(`[${pluginName}] Final index.html is unavailable while measuring initial requests.`);
  }
  const html = typeof htmlAsset.source === 'string'
    ? htmlAsset.source
    : Buffer.from(htmlAsset.source).toString('utf8');
  const dom = new JSDOM(html);
  const fileNames = Array.from(dom.window.document.querySelectorAll('link[rel="stylesheet"][href]')).map((link) => {
    const href = link.getAttribute('href');
    if (href === null) {
      throw new Error(`[${pluginName}] Standalone stylesheet is missing href.`);
    }
    return parseRelativeOutputFileName({ value: href, attribute: 'stylesheet href' });
  });

  for (const fileName of fileNames) {
    const item = bundle[fileName];
    if (item === undefined || item.type !== 'asset' || !item.fileName.endsWith('.css')) {
      throw new Error(`[${pluginName}] Initial stylesheet is not an emitted CSS asset: ${fileName}`);
    }
  }

  return [...new Set(fileNames)].sort();
}

export function createFileProtocolStandaloneBuildMetricsPlan({
  bundle,
  entryFileName,
  runtimeFileName,
  patchFileName,
  retryFileName,
}: {
  bundle: OutputBundle,
  entryFileName: string,
  runtimeFileName: string,
  patchFileName: string,
  retryFileName: string,
}): FileProtocolStandaloneBuildMetricsPlan {
  const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk');
  const chunksByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const initialClosure = collectStaticChunkClosure({ entryFileName, chunksByName });
  const initialStylesheetFileNames = collectInitialStylesheetFileNames({ bundle });
  return {
    entryFileName,
    initialRequests: [
      { fileName: runtimeFileName, kind: 'systemjs-runtime' },
      { fileName: patchFileName, kind: 'systemjs-file-protocol-patch' },
      { fileName: retryFileName, kind: 'systemjs-retry-hook' },
      ...initialClosure.map((fileName): FileProtocolStandaloneInitialRequestDescriptor => ({
        fileName,
        kind: 'application-chunk',
      })),
      ...initialStylesheetFileNames.map((fileName): FileProtocolStandaloneInitialRequestDescriptor => ({
        fileName,
        kind: 'stylesheet',
      })),
    ],
  };
}

export async function measureFileProtocolStandaloneBuildMetrics({
  plan,
  outputDirectory,
}: {
  plan: FileProtocolStandaloneBuildMetricsPlan,
  outputDirectory: string,
}): Promise<FileProtocolStandaloneBuildMetrics> {
  const entryBytes = (await fs.promises.stat(resolveFileProtocolStandaloneOutputPath({
    outputDirectory,
    fileName: plan.entryFileName,
  }))).size;
  const initialRequests = await Promise.all(plan.initialRequests.map(async (request) => ({
    ...request,
    bytes: (await fs.promises.stat(resolveFileProtocolStandaloneOutputPath({
      outputDirectory,
      fileName: request.fileName,
    }))).size,
  })));
  return {
    entryBytes,
    initialRequests,
    initialRequestBytes: initialRequests.reduce((sum, request) => sum + request.bytes, 0),
  };
}

export function collectFileProtocolStandaloneBuildBudgetFailures({ metrics, budgets }: {
  metrics: FileProtocolStandaloneBuildMetrics,
  budgets: FileProtocolStandaloneBudgets | undefined,
}): string[] {
  const failures: string[] = [];
  if (budgets?.maxInitialEntryBytes !== undefined && metrics.entryBytes > budgets.maxInitialEntryBytes) {
    failures.push(`initial entry ${metrics.entryBytes} bytes exceeds ${budgets.maxInitialEntryBytes} bytes`);
  }
  if (budgets?.maxInitialRequestBytes !== undefined && metrics.initialRequestBytes > budgets.maxInitialRequestBytes) {
    failures.push(`initial requests ${metrics.initialRequestBytes} bytes exceeds ${budgets.maxInitialRequestBytes} bytes`);
  }
  return failures;
}
