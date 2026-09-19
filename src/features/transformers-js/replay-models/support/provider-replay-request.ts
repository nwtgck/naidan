import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { z } from 'zod';
import { readProviderRequestEvidence, type ProviderReplayCatalog } from './provider-replay-evidence';
import { replayCapturedFullInvocation, replayCapturedFullInvocationWithOwnedCache, type CapturedReplayResult, type OwnedReplayCacheControl } from './provider-replay-test-captured-full';
import { createProviderReplayTestRuntime, type ProviderReplayTestRuntime } from './provider-replay-test-runtime';
import { readModelFixture } from './model-runtime-fixture';
import { createSyntheticModelBody } from './download-synthetic-session-oracle';

/** Native plan for one model test's explicitly written public requests.
 * This setup never calls chat or constructs public messages and expectations.
 * Whole-capture collection ownership stays in the separate Full regression.
 */
type RequestReplayArguments = {
  catalog: ProviderReplayCatalog; caseIds: readonly Parameters<typeof readProviderRequestEvidence>[0]['caseId'][];
  artifactPaths: readonly string[];
  imagePlatform: Parameters<typeof createProviderReplayTestRuntime>[0]['imagePlatform'];
};
type NativeReplayCall = Parameters<typeof replayCapturedFullInvocation>[0];
export type ProviderRequestNativeController = {
  cacheForInvocation: ({ caseId, localOrdinal, call }: {
    caseId: RequestReplayArguments['caseIds'][number]; localOrdinal: number; call: NativeReplayCall;
  }) => OwnedReplayCacheControl | undefined;
  completeResult: ({ caseId, localOrdinal, result, runtime }: {
    caseId: RequestReplayArguments['caseIds'][number]; localOrdinal: number;
    result: CapturedReplayResult; runtime: NativeReplayCall['runtime'];
  }) => CapturedReplayResult;
};

type PublicParameters = NonNullable<Parameters<ProviderReplayTestRuntime['provider']['chat']>[0]['parameters']>;
const nativeParameterSnapshotSchema = z.object({
  maxCompletionTokens: z.number().int().positive(), temperature: z.number(), topP: z.number(),
});
export interface ProviderRequestReplay extends ProviderReplayTestRuntime {
  beginNativeRequest({ caseId, parameters }: { caseId: RequestReplayArguments['caseIds'][number]; parameters: PublicParameters }): void;
  endNativeRequest(): void;
  assertComplete({ requests, nativeCalls }: { requests: number; nativeCalls: number }): void;
}

/** Prepare native replay only. Public chat calls and expectations belong to the model test. */
export async function createProviderRequestReplay({ ...args }: RequestReplayArguments): Promise<ProviderRequestReplay> {
  return createNativeRequestReplay({ ...args, nativeController: undefined });
}

/** Explicit synthetic-cache ownership; zero-cache callers never acquire this state. */
export async function createProviderRequestReplayWithOwnedCacheControl({ createNativeController, ...args }: RequestReplayArguments & {
  createNativeController: () => ProviderRequestNativeController;
}): Promise<ProviderRequestReplay> {
  return createNativeRequestReplay({ ...args, nativeController: createNativeController() });
}

async function createNativeRequestReplay({ catalog, caseIds, artifactPaths, imagePlatform, nativeController }: RequestReplayArguments & {
  nativeController: ProviderRequestNativeController | undefined;
}): Promise<ProviderRequestReplay> {
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) throw new Error('Missing or duplicate explicit native request plan');
  const selected = caseIds.map(caseId => readProviderRequestEvidence({ catalog, caseId }));
  const context = selected[0]!.context;
  for (const { context: resource, evidence } of selected) {
    expect(resource).toEqual(context);
    if (evidence.request === undefined || evidence.invocations.length === 0 || evidence.inputGaps.length !== 0 || evidence.unavailableOutputOrdinals.length !== 0) throw new Error('Missing output is not a successful native replay');
  }
  const metadata = readModelFixture({ modelId: context.modelId });
  expect(metadata.summary.revision).toBe(context.metadataRevision);
  expect(context.metadata.map(row => row.path).sort()).toEqual([...metadata.files.keys()].sort());
  for (const row of context.metadata) expect(createHash('sha256').update(metadata.files.get(row.path)!).digest('hex'), row.path).toBe(row.sha256);
  let requestOrdinal = 0;
  let nativeCalls = 0;
  let completedNativeCalls = 0;
  let active: { evidence: typeof selected[number]['evidence']; parameters: Readonly<z.infer<typeof nativeParameterSnapshotSchema>>; attempted: number; completed: number } | undefined;
  const harness = await createProviderReplayTestRuntime({
    modelId: context.modelId, expectedRevision: context.metadataRevision, cacheRevision: context.observedCacheRevision,
    metadataCache: context.localMetadataPaths, imagePlatform,
    artifacts: artifactPaths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId: context.modelId, revision: context.metadataRevision, path }) })),
    generate: async ({ options, runtime, model }) => {
      ++nativeCalls;
      if (active === undefined) throw new Error('Native invocation outside an explicitly begun request');
      const localOrdinal = ++active.attempted;
      const { evidence, parameters } = active;
      const caseId = evidence.caseId;
      const invocation = evidence.invocations.find(item => item.localOrdinal === localOrdinal);
      if (invocation === undefined) throw new Error(`Unrecorded extra native invocation: ${caseId}/${localOrdinal}`);
      const { localOrdinal: ordinal, ...facts } = invocation;
      const call = { invocation: { ...facts, scenario: caseId, callOrdinal: ordinal }, options, runtime, modelConfig: model.config, parameters };
      const cacheControl = nativeController?.cacheForInvocation({ caseId, localOrdinal, call });
      const result = cacheControl === undefined ? replayCapturedFullInvocation(call)
        : replayCapturedFullInvocationWithOwnedCache({ ...call, cacheControl });
      const completed = nativeController?.completeResult({ caseId, localOrdinal, result, runtime }) ?? result;
      expect(completed.sequences, 'synthetic cache control must preserve the actual recorded sequence object').toBe(result.sequences);
      ++active.completed;
      ++completedNativeCalls;
      return completed;
    },
  });
  return {
    ...harness,
    beginNativeRequest({ caseId, parameters }) {
      if (active !== undefined) throw new Error('End the preceding native request before beginning another');
      const next = selected[requestOrdinal];
      if (next === undefined || next.evidence.caseId !== caseId) throw new Error('Native request differs from its explicit plan');
      if (requestOrdinal > 0) expect(harness.service.getState().status, 'no repair Load between public requests').toBe('ready');
      // The native gate owns these three requested controls, not the whole
      // public request. Keep an independent snapshot before chat can mutate its
      // caller-owned options; Production must never move the expected value.
      active = { evidence: next.evidence, parameters: Object.freeze(nativeParameterSnapshotSchema.parse(parameters)), attempted: 0, completed: 0 };
    },
    endNativeRequest() {
      if (active === undefined) throw new Error('No active native request');
      expect(active.attempted, `${active.evidence.caseId}/attempted native inventory`).toBe(active.evidence.invocations.length);
      expect(active.completed, `${active.evidence.caseId}/completed native inventory`).toBe(active.evidence.invocations.length);
      active = undefined;
      ++requestOrdinal;
    },
    assertComplete({ requests, nativeCalls: expectedNativeCalls }) {
      expect(active, 'end the final native request after public settlement').toBeUndefined();
      expect(requestOrdinal).toBe(requests);
      expect(requestOrdinal).toBe(caseIds.length);
      expect(nativeCalls).toBe(expectedNativeCalls);
      expect(completedNativeCalls).toBe(expectedNativeCalls);
      expect(harness.observations.workers).toHaveLength(1);
      const load = z.object({ type: z.literal('APPLY'), path: z.tuple([z.literal('loadDownloadedModel')]) });
      expect(harness.observations.workers[0]!.hostMessages.filter(message => load.safeParse(message).success), 'one actual Comlink Load for this explicit chain').toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    },
    async close() {
      await harness.close();
      expect(harness.observations.workers.every(worker => worker.terminated)).toBe(true);
    },
  };
}

export const TEST_ONLY = {
};
