// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import * as traceBoundary from './production-provider-trace';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { InferenceGenerationCallback } from '@/features/transformers-js/generation-events';
import { createProductionProviderCaptureOwner, type ProductionProviderCapturePlan, type ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import { createProductionProviderCaptureEvidence, readProductionProviderCaptureEvidence, PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS } from './production-provider-capture-evidence';

const owners: Array<ReturnType<typeof createProductionProviderCaptureOwner>> = [];
let fs: ReturnType<typeof createMemoryFiles>;

async function finishMessage({ onEvent }: { onEvent: InferenceGenerationCallback }): Promise<void> {
  await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'user' } } });
}

async function emitMessage({ onEvent, text }: { onEvent: InferenceGenerationCallback; text: string }): Promise<void> {
  await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
  await onEvent({ event: { type: 'text_delta', index: 0, text } });
  await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
  await finishMessage({ onEvent });
}

function ownerFixture({ plan }: { plan: ProductionProviderCapturePlan }) {
  const client = {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>().mockResolvedValue(undefined),
    generateMessage: vi.fn<TransformersJsWorkerClient['generateMessage']>().mockImplementation(async ({ onEvent }) => finishMessage({ onEvent })),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>().mockResolvedValue(undefined),
  } satisfies TransformersJsWorkerClient;
  const owner = createProductionProviderCaptureOwner({
    runId: 'capture-run', modelId: 'fixture/model', plan, createWorkerClient: () => client,
    traceLimits: { maximumEvents: 4096, maximumCharacters: 262144 },
  });
  owners.push(owner);
  return { owner, client };
}

function exportCapture({ capture }: { capture: ProductionProviderCaptureSnapshot }) {
  return createProductionProviderCaptureEvidence({ capture, runId: 'capture-run', modelId: 'fixture/model' });
}

function recordSyntheticAppliedPartBoundary() {
  const callbacks: Array<({ chunk }: { chunk: string }) => void> = [];
  const createTrace = traceBoundary.createProductionProviderPartsTrace;
  vi.spyOn(traceBoundary, 'createProductionProviderPartsTrace').mockImplementation(args => {
    const trace = createTrace(args);
    // Deliberately inject at the observation boundary, not through a revoked
    // Worker callback. This is a late-event integrity fixture, not inference.
    callbacks.push(({ chunk }) => trace.observeAssistant({ message: {
      id: toMessageId({ raw: 'capture_assistant_0' }), role: 'assistant', createdAt: 0,
      parts: [{ type: 'text', text: chunk, completeness: 'partial' }],
      replies: { items: [] }, modelId: undefined, lmParameters: undefined, interruption: undefined,
    } }));
    return trace;
  });
  return callbacks;
}

beforeEach(() => {
  fs = createMemoryFiles();
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Capture evidence tests forbid network access');
  }));
});

afterEach(async () => {
  try {
    await Promise.all(owners.splice(0).map(owner => owner.dispose().catch(() => undefined)));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

// Snapshots come from the real owner/service/Provider/trace. Only native Worker
// clients and read-only OPFS are simulated; no real inference or Comlink claim.
describe('Production Provider capture evidence', () => {
  it('rejects event-limit evidence below the actual retained-event ceiling', async () => {
    const { owner } = ownerFixture({ plan: 'generation-v2' });
    const exported = exportCapture({ capture: await owner.run() });
    const forged = JSON.parse(exported.json);
    const trace = forged.snapshot.requests[0].trace;
    expect(trace.events.length).toBeLessThan(trace.limits.maximumEvents);
    trace.failure = { reason: 'event-limit', phase: 'before-settlement', sequence: trace.events.length };
    trace.completeness = 'incomplete';
    trace.settled.failure = { ...trace.failure };
    trace.settled.completeness = 'incomplete';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(forged), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('rejects a v2 terminal label reserved for legacy stop-on-first-failure scripts', async () => {
    const { owner } = ownerFixture({ plan: 'generation-v2' });
    const exported = exportCapture({ capture: await owner.run() });
    const forged = JSON.parse(exported.json);
    forged.snapshot.run = { status: 'stopped', reason: 'provider-rejected' };
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(forged), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('roundtrips all fixed v2 capabilities without promoting rejected requests into successful generation', async () => {
    const { owner, client } = ownerFixture({ plan: 'full-v2' });
    client.generateMessage.mockRejectedValueOnce(new Error('ordinary first rejection'));
    const capture = await owner.run();
    const exported = exportCapture({ capture });
    const restored = readProductionProviderCaptureEvidence({ json: exported.json, runId: 'capture-run', modelId: 'fixture/model' });
    expect(restored).toEqual(capture);
    expect(restored.run).toEqual({ status: 'completed' });
    expect(restored.requests[0]?.trace.settled?.outcome.status).toBe('rejected');
    expect(restored.requests[1]?.notStartedReason).toBe('first-settlement-unavailable');
    expect(restored.requests[6]?.input?.parameters.reasoning.effort).toBe('low');
    expect(restored.requests[9]?.input?.tools[0]?.fixtureId).toBe('model-support-weather-v1');
    expect(exportCapture({ capture: restored }).json).toBe(exported.json);
    expect(JSON.parse(exported.json).limitations.realModelSuccess).toBe('not-certified');
  });

  it('rejects a false scope exclusion or forged completed tail instead of hiding an unexecuted selected scenario', async () => {
    const { owner } = ownerFixture({ plan: 'generation-v2' });
    const unstarted = JSON.parse(exportCapture({ capture: owner.snapshot() }).json);
    unstarted.snapshot.run = { status: 'completed' };
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(unstarted), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const capture = await owner.run();
    const foreignScope = JSON.parse(exportCapture({ capture }).json);
    foreignScope.snapshot.requests[3].input = { captureValue: 'undefined' };
    foreignScope.snapshot.requests[3].status = 'not-started';
    foreignScope.snapshot.requests[3].notStartedReason = 'scope-not-selected';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(foreignScope), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('rejects unknown scenarios, arbitrary image URLs, altered tools and effort outside its fixed scenario', async () => {
    const { owner } = ownerFixture({ plan: 'full-v2' });
    const exported = exportCapture({ capture: await owner.run() });
    const unknownScenario = JSON.parse(exported.json);
    unknownScenario.snapshot.requests[12].scenario = 'private-scenario';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(unknownScenario), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const image = JSON.parse(exported.json);
    image.snapshot.requests[12].input.messages[0].content[1].image_url.url = 'https://private.invalid/image';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(image), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const tool = JSON.parse(exported.json);
    tool.snapshot.requests[9].input.tools[0].name = 'arbitrary_tool';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(tool), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const effort = JSON.parse(exported.json);
    effort.snapshot.requests[6].input.parameters.reasoning.effort = 'high';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(effort), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('validates actual per-request limits rather than substituting the global ceiling', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await emitMessage({ onEvent, text: 'four' });
    });
    const exported = exportCapture({ capture: await owner.run() });
    const bounded = JSON.parse(exported.json);
    bounded.snapshot.requests[0].trace.limits = { maximumEvents: 5, maximumCharacters: 102, maximumFieldCharacters: 16384 };
    expect(readProductionProviderCaptureEvidence({ json: JSON.stringify(bounded), runId: 'capture-run', modelId: 'fixture/model' }).requests[0]?.trace.limits)
      .toEqual({ maximumEvents: 5, maximumCharacters: 102, maximumFieldCharacters: 16384 });
    bounded.snapshot.requests[0].trace.limits.maximumEvents = 1;
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(bounded), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    bounded.snapshot.requests[0].trace.limits.maximumEvents = 5;
    bounded.snapshot.requests[0].trace.limits.maximumCharacters = 3;
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(bounded), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    bounded.snapshot.requests[0].trace.limits.maximumCharacters = 262145;
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(bounded), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    delete bounded.snapshot.requests[0].trace.limits;
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(bounded), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('does not execute nested image or trace-limit accessors while rejecting a forged snapshot', async () => {
    const { owner } = ownerFixture({ plan: 'full-v2' });
    const capture = structuredClone(await owner.run());
    const getter = vi.fn(() => {
      throw new Error('private');
    });
    const imageInput = capture.requests[12]?.input;
    if (imageInput === undefined) throw new Error('Missing test image');
    Object.defineProperty(imageInput.messages[0], 'content', { get: getter });
    expect(() => exportCapture({ capture })).toThrow(/^Invalid Production Provider capture evidence$/u);
    expect(getter).not.toHaveBeenCalled();
    const another = structuredClone(owner.snapshot());
    Object.defineProperty(another.requests[0]?.trace.limits, 'maximumEvents', { get: getter });
    expect(() => exportCapture({ capture: another })).toThrow(/^Invalid Production Provider capture evidence$/u);
    expect(getter).not.toHaveBeenCalled();
  });

  it('reads exported unstarted snapshots with explicit undefined and stable canonical re-export', () => {
    const { owner } = ownerFixture({ plan: 'first-continuity-independent' });
    const captured = owner.snapshot();
    const exported = exportCapture({ capture: captured });
    const restored = readProductionProviderCaptureEvidence({ json: exported.json, runId: 'capture-run', modelId: 'fixture/model' });
    expect(restored).toEqual(captured);
    expect(Object.hasOwn(restored, 'abortReason')).toBe(true);
    expect(restored.abortReason).toBeUndefined();
    expect(exportCapture({ capture: restored }).json).toBe(exported.json);
  });

  it('reads fixed inputs and synthetic applied-part late events without requiring JSON object key order', async () => {
    const callbacks = recordSyntheticAppliedPartBoundary();
    const { owner, client } = ownerFixture({ plan: 'first-continuity-independent' });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await emitMessage({ onEvent, text: '{"captureValue":"undefined"}' });
    });
    await owner.run();
    expect(callbacks).toHaveLength(3);
    callbacks[0]!({ chunk: 'late' });
    const captured = owner.snapshot();
    const exported = exportCapture({ capture: captured });
    const document = JSON.parse(exported.json);
    const unordered = { limitations: document.limitations, snapshot: { ...document.snapshot, requests: document.snapshot.requests }, limits: document.limits, undefinedEncoding: document.undefinedEncoding, format: document.format };
    const restored = readProductionProviderCaptureEvidence({ json: JSON.stringify(unordered), runId: 'capture-run', modelId: 'fixture/model' });
    expect(restored).toEqual(captured);
    expect(restored.requests[0]?.trace.lateEvents).toHaveLength(1);
    expect(restored.requests[1]?.input?.parameters.presencePenalty).toBeUndefined();
    expect(exportCapture({ capture: restored }).json).toBe(exported.json);
  });

  it('rejects omitted undefined fields, counterfeit tags and unexpected private snapshot extensions on read', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const exported = exportCapture({ capture: owner.snapshot() });
    const omitted = JSON.parse(exported.json);
    delete omitted.snapshot.abortReason;
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(omitted), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const counterfeit = JSON.parse(exported.json);
    counterfeit.snapshot.abortReason = { captureValue: 'undefined', secret: '/private' };
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(counterfeit), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const extension = JSON.parse(exported.json);
    extension.snapshot.requests[0].trace.privatePath = '/private';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(extension), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('rejects changed format, limits, limitations and unknown envelope fields on read', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const exported = exportCapture({ capture: owner.snapshot() });
    for (const changed of [
      { ...JSON.parse(exported.json), format: 'unknown-format' },
      { ...JSON.parse(exported.json), limits: { ...JSON.parse(exported.json).limits, maximumEvents: 5000 } },
      { ...JSON.parse(exported.json), limitations: { ...JSON.parse(exported.json).limitations, replayEligibility: 'ready' } },
      { ...JSON.parse(exported.json), privateEnvironment: 'secret' },
    ]) expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(changed), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('rejects foreign expected identities and malformed JSON without copying input into the error', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const { json } = exportCapture({ capture: owner.snapshot() });
    expect(() => readProductionProviderCaptureEvidence({ json, runId: 'another-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    expect(() => readProductionProviderCaptureEvidence({ json, runId: 'capture-run', modelId: 'another/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    expect(() => readProductionProviderCaptureEvidence({ json: '{"secret":"/private"', runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('bounds parsed request/event counts and rejects a tag placed in an ordinary string field', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const { json } = exportCapture({ capture: owner.snapshot() });
    const expanded = JSON.parse(json);
    expanded.snapshot.requests = Array.from({ length: 4 }, () => expanded.snapshot.requests[0]);
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(expanded), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const events = JSON.parse(json);
    events.snapshot.requests[0].trace.events = Array.from({ length: 4097 }, () => ({ kind: 'assistant-start', phase: 'before-settlement', sequence: 0 }));
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(events), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const misplaced = JSON.parse(json);
    misplaced.snapshot.modelId = { captureValue: 'undefined' };
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(misplaced), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('rejects oversized text before parsing a JSON object graph', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => readProductionProviderCaptureEvidence({ json: ' '.repeat(PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS + 1), runId: 'capture-run', modelId: 'fixture/model' })).toThrow(/^Invalid Production Provider capture evidence$/u);
    expect(parse).not.toHaveBeenCalled();
  });

  it('preserves not-started and own undefined values through versioned JSON without inventing completion', () => {
    const { owner, client } = ownerFixture({ plan: 'first-continuity-independent' });
    const capture = owner.snapshot();
    const { json, reference } = exportCapture({ capture });
    const document = JSON.parse(json);
    expect(reference).toEqual({ format: 'production-provider-capture-reference-v1', path: 'production-provider/capture.json' });
    expect(document.format).toBe('production-provider-capture-evidence-v1');
    expect(document.undefinedEncoding).toBe('capture-value-undefined-v1');
    expect(document.snapshot.run).toEqual({ status: 'not-started' });
    expect(document.snapshot.abortReason).toEqual({ captureValue: 'undefined' });
    expect(document.snapshot.requests[0].input).toEqual({ captureValue: 'undefined' });
    expect(document.snapshot.requests[0].trace.settled).toEqual({ captureValue: 'undefined' });
    expect(document.snapshot.requests[0].trace.failure).toEqual({ captureValue: 'undefined' });
    expect(document.limitations.replayEligibility).toBe('not-established');
    expect(document.limitations.realModelSuccess).toBe('not-certified');
    expect(client.loadDownloadedModel).not.toHaveBeenCalled();
    expect(capture.requests[0]?.input).toBeUndefined();
  });

  it('exports synthetic applied-part late observations without rewriting completed fixed inputs or settled history', async () => {
    const callbacks = recordSyntheticAppliedPartBoundary();
    const { owner, client } = ownerFixture({ plan: 'first-continuity-independent' });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await emitMessage({ onEvent, text: 'first' });
    });
    const capture = await owner.run();
    expect(callbacks).toHaveLength(3);
    callbacks[0]!({ chunk: '-late' });
    const before = exportCapture({ capture });
    const document = JSON.parse(exportCapture({ capture: owner.snapshot() }).json);
    expect(JSON.parse(before.json).snapshot.requests[0].trace.lateEvents).toEqual([]);
    expect(document.snapshot.requests[0].trace.lateEvents[0]).toMatchObject({ kind: 'part_text', text: '-late', phase: 'after-settlement' });
    expect(document.snapshot.requests[1].input.messages[1]).toEqual({ role: 'assistant', parts: [{ id: 'part_0', type: 'text', text: 'first', completeness: 'complete' }] });
    expect(document.snapshot.requests[0].input.parameters).toMatchObject({
      maxCompletionTokens: 16, presencePenalty: { captureValue: 'undefined' }, frequencyPenalty: { captureValue: 'undefined' },
      stop: { captureValue: 'undefined' }, reasoning: { effort: { captureValue: 'undefined' } },
    });
    expect(document.snapshot.run.status).toBe('completed');
    expect(document.limitations.nativeInvocations).toBe('not-collected-by-this-owner');
  });

  it('retains a pending request snapshot and an abort without describing either as provider settlement', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'partial' } });
      await vi.waitFor(() => expect(owner.snapshot().requests[0]?.trace.events).toContainEqual(expect.objectContaining({ kind: 'part_text', text: 'partial' })));
      await new Promise<void>(resolve => {
        release = resolve; entered();
      });
      await finishMessage({ onEvent });
    });
    const run = owner.run();
    await started;
    owner.abort({ reason: 'deadline' });
    const document = JSON.parse(exportCapture({ capture: owner.snapshot() }).json);
    expect(document.snapshot.requests[0].status).toBe('awaiting-settlement');
    expect(document.snapshot.requests[0].trace.settled).toEqual({ captureValue: 'undefined' });
    expect(document.snapshot.abortReason).toBe('deadline');
    expect(document.snapshot.events.at(-1).kind).toBe('abort-requested');
    release(); await run;
  });

  it('keeps a completed settled projection exportable after synthetic applied-part late observation overflow', async () => {
    const callbacks = recordSyntheticAppliedPartBoundary();
    const { owner } = ownerFixture({ plan: 'first-only' });
    const completed = await owner.run();
    expect(callbacks).toHaveLength(1);
    callbacks[0]!({ chunk: 'x'.repeat(16385) });
    const document = JSON.parse(exportCapture({ capture: owner.snapshot() }).json);
    expect(document.snapshot.run.status).toBe('completed');
    expect(document.snapshot.requests[0].trace.completeness).toBe('incomplete');
    expect(document.snapshot.requests[0].trace.failure).toMatchObject({ phase: 'after-settlement', reason: 'character-limit' });
    expect(document.snapshot.requests[0].trace.settled.completeness).toBe('complete');
    expect(JSON.parse(exportCapture({ capture: completed }).json).snapshot.requests[0].trace.completeness).toBe('complete');
  });

  it('exports a real Provider rejection but rejects relabeling it as completed', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    client.generateMessage.mockRejectedValue(new Error('Private runtime message'));
    const rejected = await owner.run();
    const document = JSON.parse(exportCapture({ capture: rejected }).json);
    expect(document.snapshot.run).toEqual({ status: 'stopped', reason: 'provider-rejected' });
    expect(document.snapshot.requests[0].trace.settled.outcome.status).toBe('rejected');
    expect(() => exportCapture({ capture: { ...rejected, run: { status: 'completed' } } })).toThrow();
  });

  it('exports an incomplete settled projection but does not certify its run as completed', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    client.generateMessage.mockImplementation(async ({ onEvent }) => {
      await emitMessage({ onEvent, text: 'x'.repeat(16385) });
    });
    const incomplete = await owner.run();
    const document = JSON.parse(exportCapture({ capture: incomplete }).json);
    expect(document.snapshot.run).toEqual({ status: 'stopped', reason: 'capture-incomplete' });
    expect(document.snapshot.requests[0].trace.settled.outcome.status).toBe('fulfilled');
    expect(document.snapshot.requests[0].trace.settled.completeness).toBe('incomplete');
    expect(() => exportCapture({ capture: { ...incomplete, run: { status: 'completed' } } })).toThrow();
  });

  it('does not infer physical termination from a pending or failed disposal', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    await owner.run();
    let reject!: (reason: unknown) => void;
    client.dispose.mockImplementationOnce(() => new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }));
    const disposal = owner.dispose();
    const pending = JSON.parse(exportCapture({ capture: owner.snapshot() }).json);
    expect(pending.snapshot).toMatchObject({ lifetime: 'closing', disposal: 'pending', observation: 'end-requested-by-dispose' });
    reject(new Error('Synthetic cleanup error'));
    await expect(disposal).rejects.toThrow('Synthetic cleanup error');
    const failed = JSON.parse(exportCapture({ capture: owner.snapshot() }).json);
    expect(failed.snapshot).toMatchObject({ lifetime: 'closed', disposal: 'failed', observation: 'end-requested-by-dispose' });
    expect(failed.snapshot.events.at(-1).kind).toBe('dispose-failed');
  });

  it('rejects mismatched run, request, trace, and model identities', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const capture = owner.snapshot();
    expect(() => createProductionProviderCaptureEvidence({ capture, runId: 'other', modelId: 'fixture/model' })).toThrow('Invalid Production Provider capture evidence');
    expect(() => createProductionProviderCaptureEvidence({ capture, runId: 'capture-run', modelId: 'fixture/other' })).toThrow('Invalid Production Provider capture evidence');
    const request = capture.requests[0]!;
    expect(() => exportCapture({ capture: { ...capture, requests: [{ ...request, requestId: 'other-first-turn' }] } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, requests: [{ ...request, trace: { ...request.trace, requestId: 'other-first-turn' } }] } })).toThrow();
  });

  it('rejects unknown secret fields at the root and nested trace without leaking their names or values', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const capture = owner.snapshot();
    const invalid = { ...capture, privateSecretPath: '/private/secret' };
    expect(() => exportCapture({ capture: invalid })).toThrow(/^Invalid Production Provider capture evidence$/u);
    const request = capture.requests[0]!;
    const nested = { ...capture, requests: [{ ...request, trace: { ...request.trace, privateEnvironment: 'private-environment' } }] };
    expect(() => exportCapture({ capture: nested })).toThrow(/^Invalid Production Provider capture evidence$/u);
  });

  it('does not execute getters or a custom toJSON while rejecting untrusted snapshots', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const capture = owner.snapshot();
    const getter = vi.fn(() => 'fixture/model');
    const toJSON = vi.fn(() => ({ secret: 'do-not-export' }));
    const accessor = Object.defineProperty({ ...capture }, 'modelId', { get: getter });
    const customSerialization = { ...capture, toJSON };
    expect(() => exportCapture({ capture: accessor })).toThrow();
    expect(() => exportCapture({ capture: customSerialization })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('distinguishes omitted known fields from explicitly captured undefined', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const { abortReason: _omitted, ...capture } = owner.snapshot();
    expect(() => exportCapture({ capture: capture as ProductionProviderCaptureSnapshot })).toThrow();
  });

  it('rejects excess requests, owner events, per-request events, fields and character totals', () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const capture = owner.snapshot();
    const request = capture.requests[0]!;
    expect(() => exportCapture({ capture: { ...capture, requests: Array.from({ length: 4 }, () => request) } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, events: Array.from({ length: 5 }, (_, sequence) => ({ sequence, kind: 'run-started', activeRequestId: undefined })) } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, requests: [{ ...request, trace: { ...request.trace, events: Array.from({ length: 4097 }, (_, sequence) => ({ sequence, phase: 'before-settlement', kind: 'assistant-start' })) } }] } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, requests: [{ ...request, trace: { ...request.trace, events: [{ sequence: 0, phase: 'before-settlement', kind: 'chunk', chunk: 'x'.repeat(16385) }] } }] } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, requests: [{ ...request, trace: { ...request.trace, retainedCharacters: 262145 } }] } })).toThrow();
  });

  it('applies event limits per request rather than silently imposing a smaller combined-run limit', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-continuity-independent' });
    client.generateMessage.mockImplementation(async ({ onEvent }) => {
      for (let index = 0; index < 470; index += 1) {
        await onEvent({ event: { type: 'part_start', index, kind: 'text' } });
        await onEvent({ event: { type: 'text_delta', index, text: 'x' } });
        await onEvent({ event: { type: 'part_end', index, completeness: 'complete' } });
      }
      await finishMessage({ onEvent });
    });
    const document = JSON.parse(exportCapture({ capture: await owner.run() }).json);
    expect(document.limits.scope).toBe('per-request');
    expect(document.snapshot.requests.map((request: { trace: { events: unknown[] } }) => request.trace.events.length)).toEqual([1412, 1412, 1412]);
  });

  it('rejects completed runs containing unstarted requests and incompatible lifetime states', () => {
    const { owner } = ownerFixture({ plan: 'first-continuity-independent' });
    const capture = owner.snapshot();
    expect(() => exportCapture({ capture: { ...capture, run: { status: 'completed' } } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, lifetime: 'closed' } })).toThrow();
    expect(() => exportCapture({ capture: { ...capture, lifetime: 'closing', disposal: 'completed', observation: 'end-requested-by-dispose' } })).toThrow();
  });

  it('rejects execution after an unstarted request and modified synthetic history', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-continuity-independent' });
    const initial = owner.snapshot();
    client.generateMessage.mockImplementation(async ({ onEvent }) => {
      await emitMessage({ onEvent, text: 'settled' });
    });
    const completed = await owner.run();
    expect(() => exportCapture({ capture: { ...completed, run: { status: 'running' }, requests: [initial.requests[0]!, ...completed.requests.slice(1)] } })).toThrow();
    const request = completed.requests[1]!;
    if (request.input === undefined) throw new Error('Expected captured continuity');
    const altered = { ...request, input: { ...request.input, messages: [{ role: 'user' as const, content: 'arbitrary user content' }] } };
    expect(() => exportCapture({ capture: { ...completed, requests: [completed.requests[0]!, altered, completed.requests[2]!] } })).toThrow();
  });
});

describe('versioned parts observation evidence', () => {
  it('roundtrips applied reasoning, empty text, and partial content without creating think tags', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-continuity-independent' });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'reasoning' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: '  R\r\n' } });
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
      await onEvent({ event: { type: 'part_start', index: 1, kind: 'text' } });
      await onEvent({ event: { type: 'part_end', index: 1, completeness: 'complete' } });
      await onEvent({ event: { type: 'part_start', index: 2, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 2, text: '<think>literal</think>🙂' } });
      await onEvent({ event: { type: 'part_end', index: 2, completeness: 'partial' } });
      await onEvent({ event: { type: 'result', result: { type: 'interrupted', reason: 'limit' } } });
    });
    const captured = await owner.run();
    expect(captured.format).toBe('production-provider-capture-v3');
    expect(captured.capabilities.providerCallbacks).toBe('parts_and_tools_projection');
    expect(captured.requests[1]?.input?.messages[1]).toEqual({ role: 'assistant', parts: [
      { id: 'part_0', type: 'reasoning', text: '  R\r\n', completeness: 'complete' },
      { id: 'part_1', type: 'text', text: '', completeness: 'complete' },
      { id: 'part_2', type: 'text', text: '<think>literal</think>🙂', completeness: 'partial' },
    ] });
    const artifact = exportCapture({ capture: captured });
    const parsed = readProductionProviderCaptureEvidence({ json: artifact.json, runId: 'capture-run', modelId: 'fixture/model' });
    expect(parsed).toEqual(captured); expect(exportCapture({ capture: parsed }).json).toBe(artifact.json);
    expect(parsed.requests[0]?.trace.settled?.outcome).toEqual({ status: 'fulfilled' });
    expect(parsed.requests[0]?.trace.events).toContainEqual(expect.objectContaining({ kind: 'generation_interrupted', reason: 'limit' }));
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    // The next ordinary Provider request can reject an unsupported parts shape.
    // It must not repair that shape to make this investigation succeed.
  });

  it('rejects claiming the new observer is a callback-era trace or altering the boundary marker', async () => {
    const { owner } = ownerFixture({ plan: 'first-only' });
    const artifact = exportCapture({ capture: await owner.run() });
    for (const field of ['capture', 'trace', 'capabilities', 'limitations']) {
      const invalid = JSON.parse(artifact.json);
      switch (field) {
      case 'capture': invalid.snapshot.format = 'production-provider-capture-v2'; break;
      case 'trace': invalid.snapshot.requests[0].trace.format = 'production-provider-trace-v2'; break;
      case 'capabilities': invalid.snapshot.capabilities.providerCallbacks = 'bounded-projection'; break;
      case 'limitations': invalid.limitations.providerCallbacks = 'bounded-projection'; break;
      }
      expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(invalid), runId: 'capture-run', modelId: 'fixture/model' })).toThrow('Invalid Production Provider capture evidence');
    }
  });

  it('rejects renaming a completed text revision to reasoning while retaining valid counters and settlement', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => emitMessage({ onEvent, text: 'A' }));
    const document = JSON.parse(exportCapture({ capture: await owner.run() }).json);
    const trace = document.snapshot.requests[0].trace;
    const position = trace.events.length - 2;
    expect(trace.events[position]).toMatchObject({ kind: 'part_text', partType: 'text', completeness: 'complete' });
    trace.events[position].partType = 'reasoning'; trace.settled.events[position].partType = 'reasoning';
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(document), runId: 'capture-run', modelId: 'fixture/model' })).toThrow('Invalid Production Provider capture evidence');
  });

  it('rejects declaring an actual partial response finished even when both copied event lists agree', async () => {
    const { owner, client } = ownerFixture({ plan: 'first-only' });
    client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'prefix' } });
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'partial' } });
      await onEvent({ event: { type: 'result', result: { type: 'interrupted', reason: 'limit' } } });
    });
    const captured = await owner.run();
    const artifact = exportCapture({ capture: captured });
    expect(readProductionProviderCaptureEvidence({ json: artifact.json, runId: 'capture-run', modelId: 'fixture/model' })).toEqual(captured);
    const document = JSON.parse(artifact.json); const trace = document.snapshot.requests[0].trace;
    const event = trace.events.at(-1);
    const replacement = { sequence: event.sequence, phase: event.phase, kind: 'generation_finished', next: 'user' };
    trace.events[trace.events.length - 1] = replacement; trace.settled.events[trace.settled.events.length - 1] = replacement;
    expect(() => readProductionProviderCaptureEvidence({ json: JSON.stringify(document), runId: 'capture-run', modelId: 'fixture/model' })).toThrow('Invalid Production Provider capture evidence');
  });
});


describe('fixed continuity does not omit unexpected tool history', () => {
  const plans: ProductionProviderCapturePlan[] = ['first-continuity-independent', 'generation-continuity-v2'];
  for (const plan of plans) {
    it(`keeps the observed first operation but declines lossy continuity for ${plan}`, async () => {
      const { owner, client } = ownerFixture({ plan });
      client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
        await onEvent({ event: { type: 'tool_start', index: 0 } });
        await onEvent({ event: { type: 'tool_call', index: 0, toolCall: { id: toToolCallId({ raw: 'unexpected-call' }), type: 'function', function: { name: 'unadvertised_tool', arguments: '{}' } } } });
        await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'tool_results' } } });
      });
      const captured = await owner.run();
      expect(captured.requests[0]?.trace.settled?.outcome.status).toBe('fulfilled');
      expect(captured.requests[0]?.trace.events).toContainEqual(expect.objectContaining({ kind: 'part_call', toolName: 'unadvertised_tool' }));
      expect(captured.requests[0]?.trace.events).toContainEqual(expect.objectContaining({ kind: 'tool-error', messageCapture: 'omitted-for-privacy' }));
      expect(captured.requests[1]?.input).toBeUndefined();
      expect(client.generateMessage.mock.calls.some(([request]) => request.messages.some(message => message.content === 'Continue the synthetic conversation with a short response.'))).toBe(false);
      expect(readProductionProviderCaptureEvidence({ json: exportCapture({ capture: captured }).json, runId: 'capture-run', modelId: 'fixture/model' })).toEqual(captured);
      if (plan === 'generation-continuity-v2') {
        expect(captured.requests[1]?.notStartedReason).toBe('first-settlement-unavailable');
        expect(captured.requests[2]?.status).toBe('settled');
      } else expect(captured.run).toEqual({ status: 'stopped', reason: 'capture-incomplete' });
    });
  }
});
