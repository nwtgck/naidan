import path from 'node:path';
import type { PluginOption } from 'vite';
import type {
  NaidanStandalonePluginOptions,
  NaidanStandalonePolicies,
  NaidanStandaloneSourceAudit,
} from './plugin-types.js';
import type {
  ClassicScriptAssetDiagnostic,
  ChunkDiagnostic,
  HtmlDiagnostic,
  RawWorkerOutputDiagnostic,
  RawWorkerSourceCandidateDiagnostic,
  StandaloneBuildDiagnostics,
  ViteWorkerQueryDiagnostic,
  VirtualModuleDiagnostic,
  WorkerRealmGlobalDiagnostic,
} from './plugin/diagnostics.js';
import { normalizeWorkerDefinitions } from './plugin/worker-definition.js';
import { createStandaloneBuildConfigPlugin } from './plugin/build-config.js';
import { createSystemJsRuntimeValidationPlugin } from './plugin/systemjs-runtime-validation.js';
import {
  createWorkerEntryPlugin,
  ERROR_MESSAGE_TYPE,
  INIT_MESSAGE_TYPE,
  READY_MESSAGE_TYPE,
} from './plugin/worker-entry.js';
import { createViteWorkerQueryPolicyPlugin } from './plugin/source-policy/vite-worker-query.js';
import { createImportScriptsAssetPlugin } from './plugin/source-policy/import-scripts.js';
import {
  createWorkerRealmGlobalGuardPlugin,
  DEFAULT_UI_ONLY_GLOBALS,
} from './plugin/source-policy/worker-realm-globals.js';
import { createRawWorkerConstructorPolicyPlugin } from './plugin/source-policy/raw-worker.js';
import { createCommonJsCompatibilityPlugin } from './plugin/source-policy/commonjs.js';
import { createWorkerCssGuardPlugin } from './plugin/worker-css.js';
import { createExternalWasmGuardPlugin } from './plugin/external-wasm.js';
import { createVitePreloadHelperCompatibilityPlugin } from './plugin/preload-helper.js';
import { createEffectFreeEmptyCssPruningPlugin } from './plugin/empty-css.js';
import { createSystemJsOutputPlugin } from './plugin/systemjs-output.js';
import {
  createFileProtocolStandaloneReleaseValidationPlugin,
  type FileProtocolStandaloneSourceAuditSummary,
} from './release-validation.js';

export type {
  NaidanStandalonePluginOptions,
  NaidanStandalonePolicies,
  NaidanStandaloneSourceAudit,
  NaidanStandaloneWorkerDefinition,
} from './plugin-types.js';

function createSourceAuditDiagnostic(
  sourceAudit: NaidanStandaloneSourceAudit,
): FileProtocolStandaloneSourceAuditSummary {
  switch (sourceAudit.mode) {
  case 'inline':
    return { mode: 'inline' };
  case 'external':
    return { mode: 'external', evidence: sourceAudit.evidence };
  default: {
    const exhaustive: never = sourceAudit;
    throw new Error(`Unhandled source audit mode: ${String(exhaustive)}`);
  }
  }
}

export function createNaidanStandalonePlugin({
  workers,
  systemRuntimePath,
  systemRuntimeSourceMapPath,
  diagnostics = {},
  startupSlowNoticeDelayMs = 15_000,
  policies = {},
  sourceAudit = { mode: 'inline' },
  releaseValidation,
}: NaidanStandalonePluginOptions): PluginOption {
  if (!systemRuntimePath) throw new TypeError('systemRuntimePath is required');
  if (!Number.isFinite(startupSlowNoticeDelayMs) || startupSlowNoticeDelayMs < 0) {
    throw new TypeError('startupSlowNoticeDelayMs must be a non-negative finite number');
  }
  if (!sourceAudit || !['inline', 'external'].includes(sourceAudit.mode)) {
    throw new TypeError('sourceAudit.mode must be "inline" or "external"');
  }
  if (
    sourceAudit.mode === 'external'
    && (typeof sourceAudit.evidence !== 'string' || sourceAudit.evidence.trim() === '')
  ) {
    throw new TypeError('sourceAudit.evidence is required when sourceAudit.mode is "external"');
  }

  const normalizedWorkers = normalizeWorkerDefinitions({ workers });

  const buildDiagnostics = Object.assign(diagnostics, {
    format: 'naidan-file-protocol-standalone-worker-build-v1',
    sourceAudit: createSourceAuditDiagnostic(sourceAudit),
    chunks: new Array<ChunkDiagnostic>(),
    classicScriptAssets: new Array<ClassicScriptAssetDiagnostic>(),
    virtualModules: new Array<VirtualModuleDiagnostic>(),
    html: new Array<HtmlDiagnostic>(),
    rawWorkerSourceCandidates: new Array<RawWorkerSourceCandidateDiagnostic>(),
    rawWorkerConstructors: new Array<RawWorkerOutputDiagnostic>(),
    viteWorkerQueryImports: new Array<ViteWorkerQueryDiagnostic>(),
    workerRealmGlobalReferences: new Array<WorkerRealmGlobalDiagnostic>(),
  });

  const normalizedSystemRuntimePath = path.resolve(systemRuntimePath);
  const normalizedSystemRuntimeSourceMapPath = systemRuntimeSourceMapPath === undefined
    ? undefined
    : path.resolve(systemRuntimeSourceMapPath);
  const systemRuntimeFileName = 'file-protocol-standalone/system.min.js';
  const effectFreeEmptyCssFileNames = new Set<string>();
  const workerRealmGlobalGuardPlugins = (() => {
    switch (sourceAudit.mode) {
    case 'inline':
      return [createWorkerRealmGlobalGuardPlugin({
        workers: normalizedWorkers,
        diagnostics: buildDiagnostics,
        allowWorkerRealmGlobal: policies.allowWorkerRealmGlobal,
        uiOnlyGlobals: policies.uiOnlyGlobals ?? DEFAULT_UI_ONLY_GLOBALS,
      })];
    case 'external':
      return [];
    default: {
      const exhaustive: never = sourceAudit;
      throw new Error(`Unhandled source audit mode: ${String(exhaustive)}`);
    }
    }
  })();
  return [
    // 1. Establish the standalone build and unified UI/Worker graph.
    createStandaloneBuildConfigPlugin({ diagnostics: buildDiagnostics }),
    createSystemJsRuntimeValidationPlugin({
      systemRuntimePath: normalizedSystemRuntimePath,
      systemRuntimeSourceMapPath: normalizedSystemRuntimeSourceMapPath,
    }),
    createWorkerEntryPlugin({
      workers: normalizedWorkers,
      diagnostics: buildDiagnostics,
      systemRuntimePath: normalizedSystemRuntimePath,
      systemRuntimeFileName,
    }),
    // 2. Reject unsupported source/module-graph shapes before final bundling.
    // These checks use cheap lexical prefilters and parse only candidate modules.
    // Keep them enabled even when the expensive Worker-realm source audit is
    // supplied externally: a newly introduced Vite Worker graph or importScripts
    // dependency must fail in the build that introduced it, not at a later audit.
    createViteWorkerQueryPolicyPlugin({
      diagnostics: buildDiagnostics,
      allowViteWorkerQueryImport: policies.allowViteWorkerQueryImport,
    }),
    createImportScriptsAssetPlugin({
      diagnostics: buildDiagnostics,
      classicScriptOutputBase: 'assets/chunks',
      workers: normalizedWorkers,
    }),
    ...workerRealmGlobalGuardPlugins,
    // 3. Reject unsupported shapes that are meaningful only after composition.
    // Final-output Raw Worker rejection remains mandatory in both modes. External
    // audit skips only the source-candidate Raw Worker diagnostics and the
    // Worker-realm global graph audit; cheap source guards above stay active.
    createRawWorkerConstructorPolicyPlugin({
      diagnostics: buildDiagnostics,
      allowRawWorkerConstructor: policies.allowRawWorkerConstructor,
      inspectSource: sourceAudit.mode === 'inline',
    }),
    createCommonJsCompatibilityPlugin({ diagnostics: buildDiagnostics }),
    createWorkerCssGuardPlugin({
      workers: normalizedWorkers,
      diagnostics: buildDiagnostics,
      allowWorkerOnlyCssAssets: policies.allowWorkerOnlyCssAssets === true,
    }),
    createExternalWasmGuardPlugin({
      allowExternalWasmAssets: policies.allowExternalWasmAssets === true,
    }),
    // 4. Preserve Vite lazy-CSS semantics, then finalize file:// SystemJS output.
    createVitePreloadHelperCompatibilityPlugin({ diagnostics: buildDiagnostics }),
    createEffectFreeEmptyCssPruningPlugin({ effectFreeEmptyCssFileNames }),
    createSystemJsOutputPlugin({
      diagnostics: buildDiagnostics,
      systemRuntimeFileName,
      systemJsFileScriptLoaderPatchFileName: 'file-protocol-standalone/systemjs-file-protocol-patch.js',
      systemJsRetryHookFileName: 'file-protocol-standalone/systemjs-physical-load-retry.js',
      startupSlowNoticeDelayMs,
      effectFreeEmptyCssFileNames,
    }),
    // 5. Validate the complete written distribution before packaging.
    ...(releaseValidation === undefined ? [] : [createFileProtocolStandaloneReleaseValidationPlugin({
      ...releaseValidation,
      sourceAudit: createSourceAuditDiagnostic(sourceAudit),
      workers: normalizedWorkers.map(({ name, entry }) => ({ name, sourceEntry: entry })),
      runtimeFileNames: [systemRuntimeFileName],
    })]),
  ];
}

export const naidanStandaloneWorkerProtocol = Object.freeze({
  initMessageType: INIT_MESSAGE_TYPE,
  readyMessageType: READY_MESSAGE_TYPE,
  errorMessageType: ERROR_MESSAGE_TYPE,
});
