import { z } from 'zod';
import type { Core } from './core';
import type { LowLevelFunctions } from 'llama-cpp-browser-core/llama-cpp/api/functions';
import type { VisionBf16Storage, VisionBf16StorageObservation } from './vision-bf16-storage-schema';
import type { VisionBf16Diagnostics } from './vision-bf16-diagnostics';

// The public mtmd-vision-bf16.h contract. Parameter records remain pointer-lowered
// by the record bridge; no raw calls or hard-coded record offsets here.
const names = {
  version: 'mtmd_vision_bf16_storage_version',
  initialize: 'mtmd_init_from_file_with_vision_bf16_storage',
  requested: 'mtmd_context_vision_bf16_storage',
} as const;
const constants = ['MTMD_VISION_BF16_STORAGE_INVALID', 'MTMD_VISION_BF16_STORAGE_LEGACY_EXPAND', 'MTMD_VISION_BF16_STORAGE_RETAIN_CHECKED'] as const;
const metadataSchema = z.object({
  constants: z.array(z.string()),
  records: z.array(z.object({ name: z.string() })),
  functions: z.array(z.object({ name: z.string(), export: z.string(), returnKind: z.string(), returnType: z.string(), parameters: z.array(z.object({ kind: z.string(), cType: z.string() })) })),
});
export type VisionBf16Capability = { status: 'available' } | { status: 'absent', reason: 'api-absent' } | { status: 'incompatible', reason: 'api-incompatible' };

function canonicalType({ value }: { value: string }): string {
  return value.replace(/\b(?:const|struct|enum)\s+/g, '').replace(/\s+/g, '');
}

export function inspectVisionBf16Capability({ schema }: { schema: unknown }): VisionBf16Capability {
  const parsed = metadataSchema.safeParse(schema);
  if (!parsed.success) {
    return { status: 'incompatible', reason: 'api-incompatible' };
  }
  const metadata = parsed.data;
  const functions = Object.values(names).map(name => metadata.functions.filter(fn => fn.name === name));
  const constantCounts = constants.map(name => metadata.constants.filter(value => value === name).length);
  if (functions.every(entries => entries.length === 0) && constantCounts.every(count => count === 0)) {
    return { status: 'absent', reason: 'api-absent' };
  }
  if (functions.some(entries => entries.length !== 1) || constantCounts.some(count => count !== 1)
    || metadata.records.filter(record => record.name === 'mtmd_context_params').length !== 1) {
    return { status: 'incompatible', reason: 'api-incompatible' };
  }
  const [version, initialize, requested] = functions.map(entries => entries[0]!);
  const signature = ({ fn, name, returns, resultType, kinds, types }: { fn: z.infer<typeof metadataSchema>['functions'][number], name: string, returns: string, resultType: string, kinds: string[], types: string[] }): boolean =>
    fn.name === name && fn.returnKind === returns && canonicalType({ value: fn.returnType }) === resultType && fn.parameters.length === kinds.length
    && fn.parameters.every((parameter, index) => parameter.kind === kinds[index] && canonicalType({ value: parameter.cType }) === types[index]);
  if (!signature({ fn: version!, name: names.version, returns: 'unsigned', resultType: 'uint32_t', kinds: [], types: [] })
    || !signature({ fn: initialize!, name: names.initialize, returns: 'pointer', resultType: 'mtmd_context*', kinds: ['pointer', 'pointer', 'record', 'signed'], types: ['char*', 'llama_model*', 'mtmd_context_params', 'int32_t'] })
    || !signature({ fn: requested!, name: names.requested, returns: 'signed', resultType: 'mtmd_vision_bf16_storage', kinds: ['pointer'], types: ['mtmd_context*'] })) {
    return { status: 'incompatible', reason: 'api-incompatible' };
  }
  return { status: 'available' };
}

let capability: Promise<VisionBf16Capability> | undefined;

/** Metadata only. Never instantiate Wasm or load a model to render Settings. */
export function loadVisionBf16Capability(): Promise<VisionBf16Capability> {
  capability ??= import('llama-cpp-browser-core/llama-cpp/api/schema.mjs').then(module => inspectVisionBf16Capability({ schema: module.default }));
  return capability;
}

export function selectVisionBf16Storage({ preference, capability }: { preference: VisionBf16Storage | undefined, capability: VisionBf16Capability }): VisionBf16StorageObservation {
  const base = { preference: preference ?? 'default', capability: capability.status, evidence: 'requested-policy-only' } as const;
  switch (capability.status) {
  case 'incompatible': return { ...base, status: 'unavailable', reason: 'api-incompatible' };
  case 'absent':
    switch (preference) {
    case 'retain-checked': return { ...base, status: 'unavailable', reason: 'api-absent-explicit-retain' };
    case 'legacy-expand': return { ...base, status: 'selected', selectedMode: 'legacy-expand', reason: 'explicit' };
    case undefined: return { ...base, status: 'selected', selectedMode: 'legacy-expand', reason: 'default-legacy-api-absent' };
    default: {
      const exhaustive: never = preference;
      throw new Error(String(exhaustive));
    }
    }
  case 'available':
    switch (preference) {
    case 'legacy-expand': case 'retain-checked': return { ...base, status: 'selected', selectedMode: preference, reason: 'explicit' };
    case undefined: return { ...base, status: 'selected', selectedMode: 'legacy-expand', reason: 'auto-diagnostics-unavailable' };
    default: {
      const exhaustive: never = preference;
      throw new Error(String(exhaustive));
    }
    }
  default: {
    const exhaustive: never = capability;
    throw new Error(String(exhaustive));
  }
  }
}

type Initialize = LowLevelFunctions['mtmd_init_from_file_with_vision_bf16_storage'];
type Requested = LowLevelFunctions['mtmd_context_vision_bf16_storage'];
type ClassifierInput = Parameters<VisionBf16Diagnostics['classify']>[0];

/** Fixed optional API only, using Core.api's existing native suspension guard. */
export async function prepareVisionBf16Loader({ core, preference, readMetadata, signal }: { core: {
  api: Pick<LowLevelFunctions, 'mtmd_init_from_file' | 'mtmd_vision_bf16_storage_version' | 'mtmd_init_from_file_with_vision_bf16_storage' | 'mtmd_context_vision_bf16_storage'>,
  constant: Core['constant'], hasFunction: Core['hasFunction'],
  visionBf16Diagnostics?: VisionBf16Diagnostics | undefined,
}, preference: VisionBf16Storage | undefined, readMetadata: (() => Promise<ClassifierInput | undefined>) | undefined, signal: AbortSignal | undefined }) {
  let capability = await loadVisionBf16Capability();
  if (capability.status === 'absent' && Object.values(names).some(name => core.hasFunction({ name }))) {
    capability = { status: 'incompatible', reason: 'api-incompatible' };
  }
  const observed = selectVisionBf16Storage({ preference, capability });
  const unavailable = ({ reason }: { reason: NonNullable<VisionBf16StorageObservation['reason']> }) => {
    observed.status = 'unavailable';
    observed.reason = reason;
  };
  let initialize: Initialize | undefined;
  let requested: Requested | undefined;
  let mode: number | undefined;
  let diagnostics: VisionBf16Diagnostics | undefined;
  if (observed.status !== 'unavailable' && observed.capability === 'available') {
    const exportsPresent = Object.values(names).every(name => core.hasFunction({ name }));
    if (!exportsPresent) {
      unavailable({ reason: 'native-export-missing' });
    } else {
      const actualVersion = await core.api.mtmd_vision_bf16_storage_version();
      if (typeof actualVersion === 'number' && Number.isInteger(actualVersion) && actualVersion >= 0 && actualVersion <= 4294967295) {
        observed.apiVersion = actualVersion;
      }
      if (observed.apiVersion !== 1) {
        unavailable({ reason: 'api-version' });
      } else {
        const values = constants.map(name => core.constant({ name }));
        if (values[0] !== -1 || values[1] !== 0 || values[2] !== 1) {
          unavailable({ reason: 'api-constant' });
        } else {
          const candidateApi = core.visionBf16Diagnostics;
          if (candidateApi && await candidateApi.version() === 1) {
            diagnostics = candidateApi;
            if (preference === undefined && readMetadata) {
              signal?.throwIfAborted();
              const metadata = await readMetadata();
              signal?.throwIfAborted();
              const candidate = metadata ? await diagnostics.classify(metadata) : 'unknown';
              observed.candidate = candidate;
              switch (candidate) {
              case 'reviewed':
                observed.selectedMode = 'retain-checked';
                observed.reason = 'auto-review';
                break;
              case 'unknown': case 'legacy-first': case 'not-applicable': case 'unreviewed':
                observed.selectedMode = 'legacy-expand';
                observed.reason = 'auto-legacy';
                break;
              default: {
                const exhaustive: never = candidate;
                throw new Error(String(exhaustive));
              }
              }
            }
          }
          switch (observed.selectedMode) {
          case 'retain-checked': mode = values[2];
            break;
          case 'legacy-expand': mode = values[1];
            break;
          case undefined: throw new Error('Missing selected vision storage mode');
          default: {
            const exhaustive: never = observed.selectedMode;
            throw new Error(String(exhaustive));
          }
          }
          initialize = core.api.mtmd_init_from_file_with_vision_bf16_storage;
          requested = core.api.mtmd_context_vision_bf16_storage;
        }
      }
    }
  }
  const requireAvailable = (): void => {
    switch (observed.status) {
    case 'selected': case 'initialized': return;
    case 'unavailable': throw new Error(`Vision storage unavailable: ${observed.reason}`);
    default: {
      const exhaustive: never = observed.status;
      throw new Error(String(exhaustive));
    }
    }
  };
  return {
    get observed(): Readonly<VisionBf16StorageObservation> {
      return Object.freeze({ ...observed });
    },
    async initialize({ path, model, params, onProjector }: {
      path: bigint, model: bigint, params: bigint, onProjector: Parameters<VisionBf16Diagnostics['initialize']>[0]['onProjector'],
    }): Promise<bigint> {
      requireAvailable();
      signal?.throwIfAborted();
      switch (observed.capability) {
      case 'absent': return core.api.mtmd_init_from_file(path, model, params);
      case 'available':
        if (!initialize || mode === undefined) {
          throw new Error('Checked vision storage initializer is unavailable');
        }
        {
          let pointer: bigint;
          if (diagnostics) {
            const result = await diagnostics.initialize({ path, model, params, mode, onProjector });
            observed.loadReport = result.report;
            pointer = result.pointer;
            if (preference === undefined && observed.selectedMode === 'retain-checked' && pointer === 0n
              && result.report.status === 'retention-refused' && result.report.phase === 'preupload' && result.report.cleanup === 'complete'
              && (result.report.reason === 'projector-unreviewed' || result.report.reason === 'weight-unreviewed')) {
              signal?.throwIfAborted();
              // The rejected call may never have suspended. Let queued worker
              // cancellation run before beginning a potentially large expansion.
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              signal?.throwIfAborted();
              observed.initialMode = observed.selectedMode;
              observed.retentionRefusal = result.report;
              observed.selectedMode = 'legacy-expand';
              observed.reason = 'auto-retention-refused';
              mode = 0;
              const retry = await diagnostics.initialize({ path, model, params, mode, onProjector });
              observed.loadReport = retry.report;
              pointer = retry.pointer;
            }
          } else {
            pointer = await initialize(path, model, params, mode);
          }
          if (typeof pointer !== 'bigint' || pointer < 0n || pointer > (1n << 64n) - 1n) {
            throw new TypeError('Invalid native projector pointer');
          }
          return pointer;
        }
      case 'incompatible': throw new Error('Incompatible vision storage API');
      default: {
        const exhaustive: never = observed.capability;
        throw new Error(String(exhaustive));
      }
      }
    },
    async confirm({ pointer }: { pointer: bigint }): Promise<void> {
      requireAvailable();
      if (pointer === 0n) {
        throw new Error('Cannot query an absent projector');
      }
      if (observed.capability === 'available' && !requested) {
        throw new Error('Checked vision storage query is unavailable');
      }
      if (requested) {
        const actual = await requested(pointer);
        switch (actual) {
        case 0: observed.contextRequestedMode = 'legacy-expand';
          break;
        case 1: observed.contextRequestedMode = 'retain-checked';
          break;
        default: unavailable({ reason: 'context-request-mismatch' });
          throw new Error('Invalid requested vision storage mode');
        }
        if (actual !== mode) {
          unavailable({ reason: 'context-request-mismatch' });
          throw new Error('Requested vision storage mode mismatch');
        }
      }
      observed.status = 'initialized';
    },
  };
}

export const TEST_ONLY = {
};
