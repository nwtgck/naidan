import fs from 'node:fs/promises';
import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from './diagnostics.js';
import type { NormalizedWorkerDefinition } from './worker-definition.js';
import { createStandaloneWorkerRuntimeModuleSource } from '../standalone-worker-runtime-source.js';
import { FILE_PROTOCOL_STANDALONE_GLOBAL_NAME } from '../../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';

type WorkerEntryRecord = NormalizedWorkerDefinition & Readonly<{referenceId: string; resolvedVirtualId: string}>;

const DEFAULT_RUNTIME_PUBLIC_ID = 'virtual:naidan-standalone-worker-runtime';
const DEFAULT_RUNTIME_RESOLVED_ID = '\0naidan:standalone-worker-runtime';
export const INIT_MESSAGE_TYPE = '__naidanStandaloneWorkerInitV1';
export const READY_MESSAGE_TYPE = '__naidanStandaloneWorkerReadyV1';
export const ERROR_MESSAGE_TYPE = '__naidanStandaloneWorkerErrorV1';



export function createWorkerEntryPlugin({ workers, diagnostics, systemRuntimePath, systemRuntimeFileName }: Readonly<{
  workers: readonly NormalizedWorkerDefinition[];
  diagnostics: StandaloneBuildDiagnostics;
  systemRuntimePath: string;
  systemRuntimeFileName: string;
}>): Plugin {
  const runtimePublicId = DEFAULT_RUNTIME_PUBLIC_ID;
  const workerRecords = new Map<string, WorkerEntryRecord>();
  let systemReferenceId: string | undefined;

  return {
    name: 'naidan-file-protocol-standalone-worker-entries',
    enforce: 'pre',
    buildStart() {
      systemReferenceId = this.emitFile({
        type: 'asset',
        fileName: systemRuntimeFileName,
        source: '',
      });
      for (const worker of workers) {
        const referenceId = this.emitFile({
          type: 'chunk',
          id: worker.entry,
          name: worker.name,
        });
        workerRecords.set(worker.virtualId, {
          ...worker,
          referenceId,
          resolvedVirtualId: `\0naidan:standalone-worker-client:${worker.name}`,
        });
      }
    },
    resolveId(id) {
      if (id === runtimePublicId) return DEFAULT_RUNTIME_RESOLVED_ID;
      return workerRecords.get(id)?.resolvedVirtualId ?? null;
    },
    load(id) {
      if (id === DEFAULT_RUNTIME_RESOLVED_ID) {
        return createStandaloneWorkerRuntimeModuleSource({
          initMessageType: INIT_MESSAGE_TYPE,
          readyMessageType: READY_MESSAGE_TYPE,
          errorMessageType: ERROR_MESSAGE_TYPE,
          diagnosticsGlobalName: FILE_PROTOCOL_STANDALONE_GLOBAL_NAME,
        });
      }
      const record = [...workerRecords.values()].find(candidate => candidate.resolvedVirtualId === id);
      if (!record) return null;
      const source = `
import {
  createStandaloneWorkerFromUrls,
  debugGetStandaloneWorkerRuntimeDiagnostics,
  disposeStandaloneWorkerBootstrap,
  scheduleStandaloneWorkerBootstrapWarmup,
} from ${JSON.stringify(runtimePublicId)};
export {
  debugGetStandaloneWorkerRuntimeDiagnostics,
  disposeStandaloneWorkerBootstrap,
  scheduleStandaloneWorkerBootstrapWarmup,
};
const workerEntryUrl = import.meta.ROLLUP_FILE_URL_${record.referenceId};
const systemRuntimeUrl = import.meta.ROLLUP_FILE_URL_${systemReferenceId};
export function createStandaloneWorker(options = {}) {
  return createStandaloneWorkerFromUrls({
    ...options,
    name: options.name || ${JSON.stringify(record.defaultWorkerName ?? record.name)},
    workerEntryUrl,
    systemRuntimeUrl,
  });
}
`;
      diagnostics.virtualModules.push({
        workerName: record.name,
        virtualId: record.virtualId,
        resolvedVirtualId: record.resolvedVirtualId,
        source,
      });
      return source;
    },
    async generateBundle(_options, bundle) {
      const systemAsset = Object.values(bundle).find(
        output => output.type === 'asset' && output.fileName === systemRuntimeFileName,
      );
      if (!systemAsset || systemAsset.type !== 'asset') {
        throw new Error(`Missing emitted SystemJS runtime asset: ${systemRuntimeFileName}`);
      }
      const systemRuntimeSource = await fs.readFile(systemRuntimePath, 'utf8');
      // The standalone package intentionally omits third-party source maps to keep the
      // distribution small. Remove the dangling directive so Firefox does not report a
      // misleading file:// NetworkError for a map that is not part of the package.
      systemAsset.source = systemRuntimeSource.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u, '');
    },
  };
}
