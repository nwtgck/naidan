// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toToolCallId } from '@/01-models/ids';
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import { captureScenarioInput, captureScenarios } from './production-provider-capture-plan';
import { createProductionProviderTrace, PRODUCTION_PROVIDER_TRACE_LIMITS, type ProductionProviderSettledSnapshot, type ProductionProviderTraceEvent } from './production-provider-trace';
import { createProductionProviderCaptureEvidence, readProductionProviderCaptureEvidence } from './production-provider-capture-evidence';
import { createProductionProviderCapturePolicy, TEST_ONLY } from './production-provider-capture-policy';

type Trace = ReturnType<typeof createProductionProviderTrace>;
const runId = 'a'.repeat(64);
const modelId = 'a'.repeat(127) + '/' + 'b'.repeat(128);
const toolCallId = toToolCallId({ raw: '' });
const eventCallbacks = {
  chunk: ({ trace }) => trace.callbacks.onChunk({ chunk: '' }),
  'assistant-start': ({ trace }) => trace.callbacks.onAssistantMessageStart(),
  'tool-call': ({ trace }) => trace.callbacks.onToolCall({ id: toolCallId, toolName: '', modelVisibleArguments: '' }),
  'tool-started': ({ trace }) => trace.callbacks.onToolEvent({ id: toolCallId, event: { type: 'started' } }),
  'tool-output': ({ trace }) => trace.callbacks.onToolEvent({ id: toolCallId, event: { type: 'output', stream: 'stderr', text: '' } }),
  'tool-exit': ({ trace }) => trace.callbacks.onToolEvent({ id: toolCallId, event: { type: 'exit', exitCode: -Number.MAX_SAFE_INTEGER } }),
  'tool-success': ({ trace }) => trace.callbacks.onToolResult({ id: toolCallId, result: { status: 'success', content: '' } }),
  'tool-error': ({ trace }) => trace.callbacks.onToolResult({ id: toolCallId, result: { status: 'error', code: 'invalid_arguments', message: 'Not retained' } }),
} satisfies Record<ProductionProviderTraceEvent['kind'], ({ trace }: { trace: Trace }) => void>;

// Capacity stress only: these callbacks are not recorded model output or proof
// of a naturally executed tool loop. No Provider, Worker, or model is imported.
function captureFixture({ fill }: { fill: ({ trace }: { trace: Trace }) => void }): ProductionProviderCaptureSnapshot {
  const policy = createProductionProviderCapturePolicy({ plan: 'full-v2' });
  let firstSettled: ProductionProviderSettledSnapshot | undefined;
  const requests = captureScenarios({ plan: policy.plan }).map(scenario => {
    const requestId = runId + '-' + scenario;
    const input = captureScenarioInput({ scenario, firstSettled });
    const trace = createProductionProviderTrace({ requestId, limits: policy.traceLimits });
    fill({ trace });
    const settled = trace.settle({ outcome: 'fulfilled', error: undefined });
    if (scenario === 'first-turn') firstSettled = settled;
    return { runId, requestId, scenario, status: 'settled' as const, notStartedReason: undefined, input, trace: trace.snapshot() };
  });
  return {
    format: 'production-provider-capture-v2', runId, modelId, plan: policy.plan,
    run: { status: 'completed' }, lifetime: 'open', abortReason: undefined,
    disposal: 'not-requested', observation: 'open',
    events: [{ sequence: 0, kind: 'run-started', activeRequestId: undefined }], requests,
    capabilities: { providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'fixed-public-weather-tool', images: 'fixed-public-image' },
  };
}

function encode({ capture }: { capture: ProductionProviderCaptureSnapshot }): string {
  return createProductionProviderCaptureEvidence({ capture, runId, modelId }).json;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Capture policy tests forbid network access');
  }));
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('fixed Provider capture policy', () => {
  it('reserves the full script without changing global ceilings or generation token budgets', () => {
    const policy = createProductionProviderCapturePolicy({ plan: 'full-v2' });
    expect(policy).toEqual({
      format: 'production-provider-capture-policy-v1', plan: 'full-v2',
      traceLimits: { maximumEvents: 1024, maximumCharacters: 65536 }, maximumFieldCharacters: 16384,
      reservation: { unit: 'json-characters', scenarioCount: 13, maximumCharacters: 33554432, upperBoundCharacters: 24313856 },
    });
    expect(PRODUCTION_PROVIDER_TRACE_LIMITS).toEqual({ maximumEvents: 4096, maximumCharacters: 262144, maximumFieldCharacters: 16384 });
    const capture = captureFixture({ fill: () => undefined });
    expect(capture.requests.map(request => request.input?.parameters.maxCompletionTokens)).toEqual([16, 16, 1, 1, 1, 1, 1, 1, 1, 128, 128, 128, 1]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.traceLimits)).toBe(true);
    expect(Object.isFrozen(policy.reservation)).toBe(true);
    expect(() => Reflect.set(policy.traceLimits, 'maximumEvents', 1)).not.toThrow();
    expect(policy.traceLimits.maximumEvents).toBe(1024);
  });

  it('accounts for all encoded v2 rows even when scope leaves some requests unstarted', () => {
    expect(createProductionProviderCapturePolicy({ plan: 'generation-v2' }).reservation).toEqual({
      unit: 'json-characters', scenarioCount: 13, maximumCharacters: 33554432, upperBoundCharacters: 24313856,
    });
    expect(createProductionProviderCapturePolicy({ plan: 'first-only' }).reservation).toEqual({
      unit: 'json-characters', scenarioCount: 1, maximumCharacters: 33554432, upperBoundCharacters: 1900544,
    });
  });

  it('rejects an oversized reservation before a caller can start collection', () => {
    const startCollection = vi.fn();
    expect(() => {
      TEST_ONLY.preflightReservation({ scenarios: captureScenarios({ plan: 'full-v2' }), traceLimits: { maximumEvents: 4096, maximumCharacters: 262144 } });
      startCollection();
    }).toThrow(/^Provider capture policy exceeds the JSON reservation$/u);
    expect(startCollection).not.toHaveBeenCalled();
  });

  it('rejects script growth beyond the fixed scaffold contract', () => {
    expect(() => TEST_ONLY.preflightReservation({
      scenarios: [...captureScenarios({ plan: 'full-v2' }), 'image'], traceLimits: { maximumEvents: 1024, maximumCharacters: 65536 },
    })).toThrow(/^Provider capture policy exceeds the fixed script contract$/u);
  });

  it('keeps the actual encoder scaffold within its separate fixed reservation', () => {
    const json = encode({ capture: captureFixture({ fill: () => undefined }) });
    const document = z.object({ snapshot: z.object({ requests: z.array(z.record(z.string(), z.unknown())) }).passthrough() }).passthrough().parse(JSON.parse(json));
    for (const request of document.snapshot.requests) {
      const trace = z.record(z.string(), z.unknown()).parse(request.trace);
      const settled = z.record(z.string(), z.unknown()).parse(trace.settled);
      const failure = { reason: 'duplicate-settlement', phase: 'before-settlement', sequence: 4097 };
      request.trace = { ...trace, failure, settled: { ...settled, failure, outcome: { status: 'rejected', errorName: 'ProductionWorkerLifecycleError' } } };
      request.status = 'awaiting-settlement';
      request.notStartedReason = 'first-settlement-unavailable';
    }
    // This deliberately over-complete scaffold is not a valid captured run.
    // All real encoded fixed inputs remain present, including tools and PNG.
    expect(json.length).toBe(29511);
    expect(JSON.stringify(document, undefined, 2).length + 4096).toBeLessThanOrEqual(TEST_ONLY.scaffoldCharacters);
  });

  it('fits escaped payloads, duplicated settled events and real continuity input inside the reservation', () => {
    const policy = createProductionProviderCapturePolicy({ plan: 'full-v2' });
    const capture = captureFixture({ fill: ({ trace }) => {
      for (let index = 0; index < 4; ++index) trace.callbacks.onChunk({ chunk: '\u0000'.repeat(16384) });
      for (let index = 4; index < policy.traceLimits.maximumEvents; ++index) {
        trace.callbacks.onToolResult({ id: toolCallId, result: { status: 'error', code: 'invalid_arguments', message: 'Not retained' } });
      }
    } });
    const json = encode({ capture });
    expect(json.length).toBe(18007892);
    expect(json.length).toBeLessThanOrEqual(policy.reservation.upperBoundCharacters);
    expect(policy.reservation.upperBoundCharacters).toBeLessThan(policy.reservation.maximumCharacters);
    expect(json).toContain('\\u0000');
    const restored = readProductionProviderCaptureEvidence({ json, runId, modelId });
    expect(restored.requests[1]?.input?.messages[1]?.content).toBe('\u0000'.repeat(65536));
    expect(restored.requests.every(request => request.trace.events.length === 1024 && request.trace.retainedCharacters === 65536)).toBe(true);
    expect(restored.requests.every(request => request.trace.settled?.events.length === 1024 && request.trace.limits.maximumEvents === 1024)).toBe(true);
  });

  it.each(Object.entries(eventCallbacks).map(([kind, emit]) => ({ kind, emit })))('bounds $kind metadata in the actual pretty encoder including its settled occurrence', ({ emit }) => {
    const empty = encode({ capture: captureFixture({ fill: () => undefined }) });
    const capture = captureFixture({ fill: emit });
    const populated = encode({ capture });
    expect(populated.length - empty.length).toBeLessThanOrEqual(13 * 2 * TEST_ONLY.eventMetadataCharacters);
    const event = capture.requests[0]?.trace.events[0];
    if (event === undefined) throw new Error('Missing stress event');
    const longestSequence = JSON.stringify({ ...event, sequence: 4097 }, undefined, 2);
    // The actual encoder nests settled events at depth seven (14 spaces).
    const deepestOccurrence = longestSequence.length + 14 * longestSequence.split('\n').length + 2;
    expect(deepestOccurrence).toBeLessThanOrEqual(TEST_ONLY.eventMetadataCharacters);
  });
});
