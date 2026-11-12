import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { defaultChatContextTokens, usesWebGpu, gpuProfilingProfile, LlamaCppBrowserError, type Progress } from '@/features/llama-cpp-browser/types';
import type { WorkerPrepareInput } from '@/features/llama-cpp-browser/worker/types';
import { openModelFileAccess } from '@/features/llama-cpp-browser/worker/model-file-access';
import { sameModelFile } from '@/features/llama-cpp-browser/worker/model-file-identity';
import { releaseSession as releaseNativeSession, prepareRuntime } from '@/features/llama-cpp-browser/worker/session';
import { parseModelGraphDefinitions } from './definition';
import { bindModelGraphBoundary, modelGraphNativeSchemaHash } from './native-boundary';
import { createModelGraphEngine } from './engine';
import { combineModelGraphGgufs, copyModelGraphVocabularyMetadata, inspectModelGraphGguf, readModelGraphArchitecture, type ModelGraphByteSource } from './gguf';
import { selectModelGraphRegistration } from './registry';
import { type ModelGraphRequestRegistration } from './request-registry';
import type { ModelExecution } from '@/features/llama-cpp-browser/performance/model-execution-schema';

export type RegisteredGraphSession = {
  core: Core,
  boundary: ReturnType<typeof bindModelGraphBoundary>,
  vocabulary: Awaited<ReturnType<ReturnType<typeof bindModelGraphBoundary>['createVocabulary']>>,
  engine: Awaited<ReturnType<typeof createModelGraphEngine>>,
  vocabularySize: number, contextSize: number, batchSize: number,
  execution: Extract<ModelExecution, { kind: 'registeredModelGraph' }>,
};
type Retained = { request: WorkerPrepareInput, registration: ModelGraphRequestRegistration, session: RegisteredGraphSession };
let retained: Retained | undefined;

export async function releaseRegisteredGraph(): Promise<void> {
  const current = retained;
  retained = undefined;
  if (!current) {
    return;
  }
  const { engine, vocabulary } = current.session;
  let failure: unknown;
  try {
    await engine.close();
  } catch (error) {
    failure = error;
  }
  try {
    vocabulary.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    try {
      await releaseNativeSession({ releaseRuntime: true });
    } catch { /* Preserve the first graph cleanup failure. */ }
    throw failure;
  }
}

async function sameFiles({ left, right }: { left: WorkerPrepareInput, right: WorkerPrepareInput }): Promise<boolean> {
  const a = left.resolvedModel, b = right.resolvedModel;
  const leftLocation = a.location, rightLocation = b.location;
  if (leftLocation.kind === 'local-files' || rightLocation.kind === 'local-files') {
    if (leftLocation.kind !== 'local-files' || rightLocation.kind !== 'local-files' || leftLocation.sourceId !== rightLocation.sourceId) {
      return false;
    }
  } else if (a.modelId !== b.modelId) {
    return false;
  }
  if (a.directory.files.length !== b.directory.files.length || a.directory.primaryFile.relativePath !== b.directory.primaryFile.relativePath) {
    return false;
  }
  for (const [index, file] of a.directory.files.entries()) {
    const next = b.directory.files[index]!;
    if (file.relativePath !== next.relativePath || file.file.size !== next.file.size || file.file.lastModified !== next.file.lastModified || !await sameModelFile({ previous: file, next })) {
      return false;
    }
  }
  return true;
}

/** Resolve once per request. Disabled registries never enter this module, and a
 * failed matching override is never converted into native execution. */
export async function prepareRegisteredGraph({ request, signal, onProgress, purpose }: {
  purpose: 'text' | 'vision' | 'audio' | 'live',
  request: WorkerPrepareInput, signal: AbortSignal | undefined, onProgress: ({ progress }: { progress: Progress }) => void,
}): Promise<RegisteredGraphSession | undefined> {
  const registrations = request.modelGraphRegistrations ?? [];
  if (!registrations.length) {
    await releaseRegisteredGraph();
    return undefined;
  }
  signal?.throwIfAborted();
  const probe = await openModelFileAccess({ entry: request.resolvedModel.directory.primaryFile });
  let architecture: string;
  try {
    architecture = readModelGraphArchitecture({ source: { size: probe.getSize(), read: ({ offset, destination }) => probe.read(destination, { at: offset }) }, signal });
  } finally {
    probe.close();
  }
  const matching = registrations.filter(value => value.rule.architecture === architecture);
  if (!matching.length) {
    await releaseRegisteredGraph();
    return undefined;
  }
  if (matching.length !== 1) {
    throw new Error('Conflicting registered model graph rules');
  }
  const candidate = matching[0]!;
  const checkPurpose = (): void => {
    if (purpose !== 'text' || request.options.profile === gpuProfilingProfile) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input', details: 'The selected model graph supports text generation only, not media or the specialized GPU profiling runtime.' });
    }
  };
  if (retained && retained.registration.id === candidate.id && retained.registration.sourceSha256 === candidate.sourceSha256
    && retained.registration.rule.mode === candidate.rule.mode && retained.request.assetBaseURL === request.assetBaseURL
    && retained.request.options.profile === request.options.profile && retained.request.options.contextTokens === request.options.contextTokens
    && await sameFiles({ left: retained.request, right: request })) {
    const selected = selectModelGraphRegistration({ registrations, architecture, nativeRecognized: retained.session.boundary.architectureKnown({ name: architecture }) });
    if (!selected) {
      await releaseRegisteredGraph();
      return undefined;
    }
    checkPurpose();
    retained.session.execution = { ...retained.session.execution, label: selected.label };
    logDiagnostic({ diagnostic: { event: 'model-reused', modelExecution: retained.session.execution } });
    return retained.session;
  }
  await releaseRegisteredGraph();
  // This query reuses the native runtime without releasing its loaded model.
  // Inapplicable "unknown only" rules therefore do not destroy prompt caches.
  const { core } = await prepareRuntime({ request, signal, onProgress });
  const boundary = bindModelGraphBoundary({ core });
  const selected = selectModelGraphRegistration({ registrations, architecture, nativeRecognized: boundary.architectureKnown({ name: architecture }) });
  if (!selected) {
    return undefined;
  }
  checkPurpose();
  // Only an actually selected graph replaces the native model, not the runtime.
  await releaseNativeSession({ releaseRuntime: false });
  let vocabulary: RegisteredGraphSession['vocabulary'] | undefined;
  let engine: RegisteredGraphSession['engine'] | undefined;
  const accesses: Awaited<ReturnType<typeof openModelFileAccess>>[] = [];
  let transferred = false;
  let preparationFailed = false;
  let result: RegisteredGraphSession | undefined;
  let cleanupFailure: unknown;
  try {
    signal?.throwIfAborted();
    const definition = parseModelGraphDefinitions({ input: selected.source })[0]!.definition;
    const { directory } = request.resolvedModel;
    const files = [directory.primaryFile, ...directory.files.filter(file => file.relativePath !== directory.primaryFile.relativePath && file.relativePath !== directory.projectorFile?.relativePath)];
    const ggufs = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const access = await openModelFileAccess({ entry: file });
      accesses.push(access);
      const source: ModelGraphByteSource = { size: access.getSize(), read: ({ offset, destination }) => access.read(destination, { at: offset }) };
      ggufs.push(inspectModelGraphGguf({ source, signal }));
    }
    const { inventory, locations } = combineModelGraphGgufs({ files: ggufs });
    if (inventory.architecture !== architecture) {
      throw new Error('Model metadata changed during request admission');
    }
    vocabulary = await boundary.createVocabulary({ metadata: copyModelGraphVocabularyMetadata({ gguf: ggufs[0]!, signal }) });
    const vocabularySize = await core.api.llama_vocab_n_tokens(vocabulary.vocab);
    if (vocabularySize !== inventory.vocabularySize) {
      throw new Error('Native vocabulary size does not match the graph inventory');
    }
    const contextSize = request.options.contextTokens ?? defaultChatContextTokens, batchSize = 128;
    logDiagnostic({ diagnostic: { event: 'load-start', profile: request.options.profile } });
    engine = await createModelGraphEngine({
      core,
      definition,
      inventory,
      locations,
      contextSize,
      batchSize,
      backend: usesWebGpu({ profile: request.options.profile }) ? 'webgpu' : 'cpu',
      threads: 1,
      maximumScratchBytes: usesWebGpu({ profile: request.options.profile }) ? 16 * 1024 ** 3 : 1024 ** 3,
      signal,
      onWeightProgress: ({ loadedBytes, totalBytes }) => onProgress({ progress: { phase: 'loading', completed: loadedBytes, total: totalBytes } }),
    });
    signal?.throwIfAborted();
    const execution: RegisteredGraphSession['execution'] = { kind: 'registeredModelGraph', registrationId: selected.id, label: selected.label, architecture, format: definition.format, definitionSha256: selected.sourceSha256, nativeExtensionSha256: modelGraphNativeSchemaHash };
    const session: RegisteredGraphSession = { core, boundary, vocabulary, engine, execution, vocabularySize, contextSize, batchSize };
    retained = { request, registration: selected, session };
    transferred = true;
    logDiagnostic({ diagnostic: { event: 'context-ready', profile: request.options.profile, contextTokens: contextSize, batchTokens: batchSize, modelExecution: execution } });
    result = session;
  } catch (error) {
    preparationFailed = true;
    throw error;
  } finally {
    for (const access of accesses.reverse()) {
      try {
        access.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (!transferred) {
      try {
        await engine?.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
      try {
        vocabulary?.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
    } else if (preparationFailed || cleanupFailure !== undefined) {
      try {
        await releaseRegisteredGraph();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure !== undefined) {
      try {
        await releaseNativeSession({ releaseRuntime: true });
      } catch { /* Preparation or the first cleanup failure remains primary. */ }
    }
  }
  // An allocation/read failure thrown above remains the primary error. Only
  // an otherwise successful load may be replaced by a cleanup failure.
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
  if (result === undefined) {
    throw new Error('Registered graph preparation did not produce an owner');
  }
  return result;
}

export const TEST_ONLY = {
};
