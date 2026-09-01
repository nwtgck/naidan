import { Buffer } from 'node:buffer';
import type { OutputAsset, OutputChunk } from 'rolldown';
import type { Plugin } from 'vite';
import type { ChunkDiagnostic, StandaloneBuildDiagnostics } from './diagnostics.js';
import { rewriteStandaloneHtml } from './html-rewrite.js';
import {
  createSystemJsFileScriptLoaderPatchSource,
  createSystemJsPhysicalLoadRecoverySource,
} from '../file-protocol-startup-support.js';
import { transformToSystemJs } from './systemjs-transform.js';

function transformOutputChunkToSystemJsInPlace({
  output,
  diagnostics,
}: Readonly<{
  output: OutputChunk;
  diagnostics: StandaloneBuildDiagnostics;
}>): void {
  const chunkRecord: ChunkDiagnostic = {
    fileName: output.fileName,
    name: output.name,
    isEntry: output.isEntry,
    facadeModuleId: output.facadeModuleId,
    imports: [...output.imports],
    dynamicImports: [...output.dynamicImports],
    moduleIds: Object.keys(output.modules),
    beforeBytes: Buffer.byteLength(output.code),
  };
  const transformed = transformToSystemJs({
    code: output.code,
    fileName: output.fileName,
  });
  output.code = `${transformed.code}\n`;
  output.map = null;
  chunkRecord.afterBytes = Buffer.byteLength(output.code);
  diagnostics.chunks.push(chunkRecord);
}

export function createSystemJsOutputPlugin({
  diagnostics,
  systemRuntimeFileName,
  systemJsFileScriptLoaderPatchFileName,
  systemJsRetryHookFileName,
  startupSlowNoticeDelayMs,
  effectFreeEmptyCssFileNames,
}: Readonly<{
  diagnostics: StandaloneBuildDiagnostics;
  systemRuntimeFileName: string;
  systemJsFileScriptLoaderPatchFileName: string;
  systemJsRetryHookFileName: string;
  startupSlowNoticeDelayMs: number;
  effectFreeEmptyCssFileNames: Set<string>;
}>): Plugin {
  let systemJsFileScriptLoaderPatchReferenceId: string | undefined;
  let systemJsRetryHookReferenceId: string | undefined;
  return {
    name: 'naidan-file-protocol-standalone-systemjs-output',
    enforce: 'post',
    buildStart() {
      systemJsFileScriptLoaderPatchReferenceId = this.emitFile({
        type: 'asset',
        fileName: systemJsFileScriptLoaderPatchFileName,
        source: createSystemJsFileScriptLoaderPatchSource(),
      });
      systemJsRetryHookReferenceId = this.emitFile({
        type: 'asset',
        fileName: systemJsRetryHookFileName,
        source: createSystemJsPhysicalLoadRecoverySource(),
      });
      diagnostics.classicScriptAssets.push({
        kind: 'systemjs-file-script-loader-patch',
        outputFileName: systemJsFileScriptLoaderPatchFileName,
      });
      diagnostics.classicScriptAssets.push({
        kind: 'systemjs-physical-load-retry-hook',
        outputFileName: systemJsRetryHookFileName,
      });
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (systemJsFileScriptLoaderPatchReferenceId === undefined || systemJsRetryHookReferenceId === undefined) {
          throw new Error('SystemJS support assets were not emitted before generateBundle');
        }
        const emittedPatch = this.getFileName(systemJsFileScriptLoaderPatchReferenceId);
        const emittedRetry = this.getFileName(systemJsRetryHookReferenceId);
        if (emittedPatch !== systemJsFileScriptLoaderPatchFileName) {
          throw new Error(`Unexpected SystemJS file loader patch file name: ${emittedPatch}`);
        }
        if (emittedRetry !== systemJsRetryHookFileName) {
          throw new Error(`Unexpected SystemJS retry hook file name: ${emittedRetry}`);
        }

        const outputs = Object.values(bundle);
        const chunkOutputs = outputs.filter(
          (output): output is OutputChunk => output.type === 'chunk',
        );
        const outputByFileName = new Map(outputs.map(output => [output.fileName, output]));
        const chunkByFileName = new Map(chunkOutputs.map(output => [output.fileName, output]));
        for (const output of chunkOutputs) {
          transformOutputChunkToSystemJsInPlace({ output, diagnostics });
        }

        const htmlOutputs = Object.values(bundle).filter(
          (output): output is OutputAsset => output.type === 'asset' && output.fileName.endsWith('.html'),
        );
        if (htmlOutputs.length !== 1) {
          throw new Error(`Naidan standalone output requires exactly one HTML entry; found ${htmlOutputs.length}`);
        }
        for (const output of htmlOutputs) {
          rewriteStandaloneHtml({
            output,
            outputByFileName,
            chunkByFileName,
            systemRuntimeFileName,
            systemJsFileScriptLoaderPatchFileName,
            systemJsRetryHookFileName,
            startupSlowNoticeDelayMs,
            effectFreeEmptyCssFileNames,
            diagnostics,
          });
        }

        diagnostics.chunks.sort((left, right) => left.fileName.localeCompare(right.fileName));
        diagnostics.classicScriptAssets.sort((left, right) => left.outputFileName.localeCompare(right.outputFileName));
        diagnostics.virtualModules.sort((left, right) => left.workerName.localeCompare(right.workerName));
        diagnostics.rawWorkerSourceCandidates.sort((left, right) => left.moduleId.localeCompare(right.moduleId) || left.start - right.start);
        diagnostics.rawWorkerConstructors.sort((left, right) => left.outputFileName.localeCompare(right.outputFileName) || left.start - right.start);
        diagnostics.viteWorkerQueryImports.sort((left, right) => left.moduleId.localeCompare(right.moduleId) || left.start - right.start);
        diagnostics.html.sort((left, right) => left.fileName.localeCompare(right.fileName));
      },
    },
  };
}
