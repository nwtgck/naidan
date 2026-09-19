import { z } from 'zod';
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import { PRODUCTION_PROVIDER_TRACE_LIMITS, type ProductionProviderTraceSnapshot, type ProductionProviderTraceEvent } from './production-provider-trace';
import { capturePlanSchema, captureScenarioSchema, captureScenarios, isCapturePlanV2, isCaptureScenarioSelected, captureScenarioInput } from './production-provider-capture-plan';

export const PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH = 'production-provider/capture.json';
export const productionProviderCaptureReferenceSchema = z.object({
  format: z.literal('production-provider-capture-reference-v1'),
  path: z.literal(PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH),
}).strict();

// Validation happens during export, never in a Provider callback. Reject extra
// keys/accessors before reading fields; neither their names nor values enter errors.
function strictRecord<Shape extends z.ZodRawShape>({ shape }: { shape: Shape }) {
  const keys = Object.keys(shape);
  return z.custom<Record<string, unknown>>(value => typeof value === 'object' && value !== null && !Array.isArray(value))
    .superRefine((value, context) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))
        || keys.some(key => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return descriptor === undefined || !('value' in descriptor);
        })) context.addIssue({ code: 'custom', message: 'Invalid capture object' });
    }).pipe(z.object(shape).strict());
}

function boundedArray<Element extends z.ZodType>({ element, maximum }: { element: Element; maximum: number }) {
  return z.custom<unknown[]>(Array.isArray).superRefine((value, context) => {
    if (!Array.isArray(value)) return;
    if (value.length > maximum) {
      context.addIssue({ code: 'custom', message: 'Capture array exceeds its limit' });
      return;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)))
      || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
        .some(descriptor => descriptor === undefined || !('value' in descriptor))) {
      context.addIssue({ code: 'custom', message: 'Invalid capture array' });
    }
  }).pipe(z.array(element).max(maximum));
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const text = z.string().max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumFieldCharacters);
const phase = z.enum(['before-settlement', 'after-settlement']);
const sequence = z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumEvents + 1);
const eventBase = { sequence, phase };
const eventSchema = z.union([
  strictRecord({ shape: { ...eventBase, kind: z.literal('chunk'), chunk: text } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('assistant-start') } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('tool-call'), toolCallId: text, toolName: text, modelVisibleArguments: text } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('tool-started'), toolCallId: text } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('tool-output'), toolCallId: text, stream: z.enum(['stdout', 'stderr']), text } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('tool-exit'), toolCallId: text, exitCode: z.number().int().safe() } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('tool-success'), toolCallId: text, content: text } }),
  strictRecord({ shape: { ...eventBase, kind: z.literal('tool-error'), toolCallId: text, code: z.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']), messageCapture: z.literal('omitted-for-privacy') } }),
]);
const eventArray = boundedArray({ element: eventSchema, maximum: PRODUCTION_PROVIDER_TRACE_LIMITS.maximumEvents });
const failureSchema = strictRecord({ shape: {
  reason: z.enum(['event-limit', 'character-limit', 'unreadable-callback', 'duplicate-settlement']), phase, sequence,
} });
const maybeFailure = z.union([failureSchema, z.undefined()]);
const outcomeSchema = z.union([
  strictRecord({ shape: { status: z.literal('fulfilled') } }),
  strictRecord({ shape: { status: z.literal('rejected'), errorName: z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'ProductionWorkerLifecycleError', 'unknown']) } }),
]);
const settledSchema = strictRecord({ shape: {
  sequence, outcome: outcomeSchema, events: eventArray, completeness: z.enum(['complete', 'incomplete']), failure: maybeFailure,
} });
const traceSchema = strictRecord({ shape: {
  format: z.literal('production-provider-trace-v2'), requestId: id,
  limits: strictRecord({ shape: {
    maximumEvents: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumEvents),
    maximumCharacters: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumCharacters),
    maximumFieldCharacters: z.literal(16384),
  } }),
  completeness: z.enum(['complete', 'incomplete']), failure: maybeFailure,
  events: eventArray, settled: z.union([settledSchema, z.undefined()]), lateEvents: eventArray,
  retainedCharacters: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumCharacters),
} });
const imageTextPartSchema = strictRecord({ shape: { type: z.literal('text'), text } });
const imageUrlPartSchema = strictRecord({ shape: { type: z.literal('image_url'), image_url: strictRecord({ shape: { url: text } }) } });
const toolCallSchema = strictRecord({ shape: {
  id: z.literal('call_model_support_probe_1'), type: z.literal('function'),
  function: strictRecord({ shape: { name: z.literal('lookup_weather'), arguments: z.literal('{"city":"Tokyo"}') } }),
} });
const messageSchema = z.union([
  strictRecord({ shape: { role: z.enum(['user', 'assistant', 'system']), content: z.string().max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumCharacters) } }),
  strictRecord({ shape: { role: z.literal('user'), content: boundedArray({ maximum: 2, element: z.unknown() }).pipe(z.tuple([imageTextPartSchema, imageUrlPartSchema])) } }),
  strictRecord({ shape: { role: z.literal('assistant'), content: z.literal(''), tool_calls: boundedArray({ maximum: 1, element: z.unknown() }).pipe(z.tuple([toolCallSchema])) } }),
  strictRecord({ shape: { role: z.literal('tool'), content: text, tool_call_id: z.literal('call_model_support_probe_1') } }),
]);
const toolSchema = strictRecord({ shape: {
  fixtureId: z.literal('model-support-weather-v1'), name: z.literal('lookup_weather'), description: z.literal('Return deterministic weather fixture data.'),
  parameters: strictRecord({ shape: {
    type: z.literal('object'), properties: strictRecord({ shape: { city: strictRecord({ shape: { type: z.literal('string') } }) } }),
    required: boundedArray({ maximum: 1, element: z.literal('city') }).pipe(z.tuple([z.literal('city')])), additionalProperties: z.literal(false),
  } }),
} });
const inputSchema = strictRecord({ shape: {
  messages: boundedArray({ maximum: 3, element: messageSchema }),
  parameters: strictRecord({ shape: {
    temperature: z.literal(0), topP: z.literal(1), maxCompletionTokens: z.union([z.literal(16), z.literal(1), z.literal(128)]),
    presencePenalty: z.undefined(), frequencyPenalty: z.undefined(), stop: z.undefined(),
    reasoning: strictRecord({ shape: { effort: z.union([z.enum(['none', 'low', 'medium', 'high']), z.undefined()]) } }),
  } }),
  tools: z.union([boundedArray({ element: z.never(), maximum: 0 }).pipe(z.tuple([])), boundedArray({ element: z.unknown(), maximum: 1 }).pipe(z.tuple([toolSchema]))]),
} });
const captureSchema = strictRecord({ shape: {
  format: z.literal('production-provider-capture-v2'), runId: id.max(64),
  modelId: z.string().max(256).regex(/^(?:hf\.co\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
  plan: capturePlanSchema,
  run: z.union([
    strictRecord({ shape: { status: z.enum(['not-started', 'running', 'completed']) } }),
    strictRecord({ shape: { status: z.literal('stopped'), reason: z.enum(['provider-rejected', 'capture-incomplete', 'aborted', 'disposed', 'runtime-unavailable']) } }),
  ]),
  lifetime: z.enum(['open', 'closing', 'closed']), abortReason: z.union([z.enum(['user-requested', 'deadline']), z.undefined()]),
  disposal: z.enum(['not-requested', 'pending', 'completed', 'failed']), observation: z.enum(['open', 'end-requested-by-dispose']),
  events: boundedArray({ maximum: 4, element: strictRecord({ shape: {
    sequence: z.number().int().min(0).max(3), kind: z.enum(['run-started', 'abort-requested', 'dispose-requested', 'dispose-completed', 'dispose-failed']),
    activeRequestId: z.union([id, z.undefined()]),
  } }) }),
  requests: boundedArray({ maximum: 13, element: strictRecord({ shape: {
    runId: id.max(64), requestId: id, scenario: captureScenarioSchema,
    status: z.enum(['not-started', 'awaiting-settlement', 'settled']), input: z.union([inputSchema, z.undefined()]), trace: traceSchema,
    notStartedReason: z.union([z.enum(['not-yet-started', 'scope-not-selected', 'first-settlement-unavailable', 'legacy-script-stopped', 'runtime-unavailable', 'aborted', 'deadline', 'disposed']), z.undefined()]),
  } }) }),
  capabilities: strictRecord({ shape: {
    providerCallbacks: z.literal('bounded-projection'), nativeInvocations: z.literal('not-collected-by-this-owner'), tools: z.enum(['not-selected', 'fixed-public-weather-tool']), images: z.enum(['not-selected', 'fixed-public-image']),
  } }),
} });

// Compare recursive key sets as well as values: adding even an optional owner
// field must force a schema review. Required own undefined is checked at runtime.
type Shape<T> = T extends readonly (infer Item)[] ? readonly Shape<Item>[]
  : T extends object ? { readonly [Key in keyof T]-?: readonly [Shape<T[Key]>] } : T;
type SameShape<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;
true satisfies SameShape<Shape<ProductionProviderCaptureSnapshot>, Shape<z.output<typeof captureSchema>>>;
true satisfies SameShape<Shape<ProductionProviderTraceSnapshot>, Shape<z.output<typeof traceSchema>>>;
true satisfies SameShape<Shape<ProductionProviderTraceEvent>, Shape<z.output<typeof eventSchema>>>;

function invalidCapture(): never {
  throw new Error('Invalid Production Provider capture evidence');
}

function payloadCharacters({ event }: { event: z.output<typeof eventSchema> }): number {
  switch (event.kind) {
  case 'assistant-start': return 0;
  case 'chunk': return event.chunk.length;
  case 'tool-call': return event.toolCallId.length + event.toolName.length + event.modelVisibleArguments.length;
  case 'tool-started': case 'tool-exit': case 'tool-error': return event.toolCallId.length;
  case 'tool-output': return event.toolCallId.length + event.text.length;
  case 'tool-success': return event.toolCallId.length + event.content.length;
  default: { const exhaustive: never = event; throw new Error('Unhandled Provider trace event: ' + exhaustive); }
  }
}

function validateTrace({ trace }: { trace: ProductionProviderTraceSnapshot }): void {
  if (trace.events.length + trace.lateEvents.length > trace.limits.maximumEvents || trace.retainedCharacters > trace.limits.maximumCharacters
    || trace.events.some((event, index) => event.phase !== 'before-settlement' || event.sequence !== index)
    || (trace.completeness === 'complete') !== (trace.failure === undefined)
    || [...trace.events, ...trace.lateEvents].reduce((sum, event) => sum + payloadCharacters({ event }), 0) !== trace.retainedCharacters) invalidCapture();
  if (trace.settled === undefined) {
    if (trace.lateEvents.length !== 0 || trace.failure?.phase === 'after-settlement') invalidCapture();
  } else {
    const settled = trace.settled;
    if (settled.sequence !== trace.events.length || JSON.stringify(settled.events) !== JSON.stringify(trace.events)
      || (settled.completeness === 'complete') !== (settled.failure === undefined)
      || (settled.failure !== undefined && (settled.failure.phase !== 'before-settlement' || JSON.stringify(settled.failure) !== JSON.stringify(trace.failure)))
      || trace.lateEvents.some((event, index) => event.phase !== 'after-settlement' || event.sequence !== settled.sequence + 1 + index)) invalidCapture();
  }
  if (trace.failure !== undefined) {
    switch (trace.failure.reason) {
    case 'event-limit':
      if (trace.events.length + trace.lateEvents.length !== trace.limits.maximumEvents) invalidCapture();
      break;
    // The rejected payload is not retained, so its character count cannot be
    // reconstructed. Do not infer a full buffer from a character-limit failure.
    case 'character-limit': case 'unreadable-callback': case 'duplicate-settlement': break;
    default: { const exhaustive: never = trace.failure.reason; throw new Error('Unhandled trace failure: ' + exhaustive); }
    }
    const settlementOffset = (() => {
      switch (trace.failure.phase) {
      case 'before-settlement': return 0;
      case 'after-settlement': return 1;
      default: { const exhaustive: never = trace.failure.phase; throw new Error('Unhandled failure phase: ' + exhaustive); }
      }
    })();
    const expectedSequence = trace.events.length + trace.lateEvents.length + settlementOffset;
    if (trace.failure.sequence !== expectedSequence || (trace.failure.phase === 'before-settlement' && trace.lateEvents.length > 0)) invalidCapture();
  }
}

function validateIdentityAndScript({ capture, runId, modelId }: { capture: ProductionProviderCaptureSnapshot; runId: string; modelId: string }): void {
  if (capture.runId !== runId || capture.modelId !== modelId) invalidCapture();
  const scenarios = captureScenarios({ plan: capture.plan });
  const version2 = isCapturePlanV2({ plan: capture.plan });
  if (capture.capabilities.tools !== (isCaptureScenarioSelected({ plan: capture.plan, scenario: 'natural-tool-minimal' }) ? 'fixed-public-weather-tool' : 'not-selected')
    || capture.capabilities.images !== (isCaptureScenarioSelected({ plan: capture.plan, scenario: 'image' }) ? 'fixed-public-image' : 'not-selected')) invalidCapture();
  if (capture.requests.length !== scenarios.length || capture.events.some((event, index) => event.sequence !== index
    || (event.activeRequestId !== undefined && !capture.requests.some(request => request.requestId === event.activeRequestId)))) invalidCapture();
  let previousCanContinue = true;
  let executionTail = false;
  for (const [index, request] of capture.requests.entries()) {
    if (request.runId !== runId || request.scenario !== scenarios[index]
      || request.requestId !== runId + '-' + request.scenario || request.trace.requestId !== request.requestId) invalidCapture();
    validateTrace({ trace: request.trace });
    const expectedStatus = request.input === undefined ? 'not-started' : request.trace.settled === undefined ? 'awaiting-settlement' : 'settled';
    if (request.status !== expectedStatus || (request.input === undefined && (request.trace.events.length > 0 || request.trace.settled !== undefined || request.trace.failure !== undefined))
      || (request.status === 'not-started') !== (request.notStartedReason !== undefined)) invalidCapture();
    if (request.status !== 'not-started' && ((!version2 && !previousCanContinue) || executionTail)) invalidCapture();
    previousCanContinue = request.trace.settled?.outcome.status === 'fulfilled' && request.trace.settled.completeness === 'complete';
    const selected = isCaptureScenarioSelected({ plan: capture.plan, scenario: request.scenario });
    if (!selected && request.notStartedReason !== 'scope-not-selected') invalidCapture();
    switch (request.notStartedReason) {
    case undefined:
      if (!selected) invalidCapture();
      switch (request.status) {
      case 'awaiting-settlement': executionTail = true; break;
      case 'settled': break;
      case 'not-started': return invalidCapture();
      default: { const exhaustive: never = request.status; throw new Error('Unhandled request status: ' + exhaustive); }
      }
      break;
    case 'scope-not-selected': if (selected) invalidCapture(); break;
    case 'first-settlement-unavailable': {
      const first = capture.requests[0]?.trace.settled;
      if (!version2 || !selected || request.scenario !== 'continuity' || first === undefined
        || (first.outcome.status === 'fulfilled' && first.completeness === 'complete')) invalidCapture();
      break;
    }
    case 'not-yet-started': executionTail = true; break;
    case 'legacy-script-stopped':
      if (version2 || capture.run.status !== 'stopped' || !['provider-rejected', 'capture-incomplete'].includes(capture.run.reason)) invalidCapture();
      executionTail = true; break;
    case 'runtime-unavailable':
      if (!version2 || capture.run.status !== 'stopped' || capture.run.reason !== 'runtime-unavailable' || capture.requests[0]?.input === undefined) invalidCapture();
      executionTail = true; break;
    case 'aborted':
      if (capture.run.status !== 'stopped' || capture.run.reason !== 'aborted' || capture.abortReason !== 'user-requested') invalidCapture();
      executionTail = true; break;
    case 'deadline':
      if (capture.run.status !== 'stopped' || capture.run.reason !== 'aborted' || capture.abortReason !== 'deadline') invalidCapture();
      executionTail = true; break;
    case 'disposed':
      if (capture.run.status !== 'stopped' || capture.run.reason !== 'disposed' || capture.lifetime === 'open') invalidCapture();
      executionTail = true; break;
    default: { const exhaustive: never = request.notStartedReason; throw new Error('Unhandled not-started reason: ' + exhaustive); }
    }
    if (request.input !== undefined) {
      const expected = captureScenarioInput({ scenario: request.scenario, firstSettled: capture.requests[0]?.trace.settled });
      // Both operands are strict-schema canonical objects, never arbitrary
      // callback values. This compares every fixed field without key-order noise.
      if (JSON.stringify(inputSchema.parse(request.input)) !== JSON.stringify(inputSchema.parse(expected))) invalidCapture();
    }
  }
  switch (capture.run.status) {
  case 'completed':
    if (version2) {
      if (capture.requests.some(request => request.status !== 'settled' && request.notStartedReason !== 'scope-not-selected' && request.notStartedReason !== 'first-settlement-unavailable')) invalidCapture();
    } else if (capture.requests.some(request => request.status !== 'settled' || request.trace.settled?.outcome.status !== 'fulfilled' || request.trace.settled.completeness !== 'complete')) invalidCapture();
    break;
  case 'not-started':
    if (capture.requests.some(request => request.status !== 'not-started')) invalidCapture();
    break;
  case 'running': break;
  case 'stopped':
    switch (capture.run.reason) {
    case 'provider-rejected': case 'capture-incomplete': if (version2) invalidCapture(); break;
    case 'runtime-unavailable':
      if (!version2 || !capture.requests.some(request => request.notStartedReason === 'runtime-unavailable')) invalidCapture();
      break;
    case 'aborted': if (capture.abortReason === undefined) invalidCapture(); break;
    case 'disposed':
      switch (capture.lifetime) {
      case 'open': return invalidCapture();
      case 'closing': case 'closed': break;
      default: { const exhaustive: never = capture.lifetime; throw new Error('Unhandled lifetime: ' + exhaustive); }
      }
      break;
    default: { const exhaustive: never = capture.run.reason; throw new Error('Unhandled stopped run: ' + exhaustive); }
    }
    break;
  default: { const exhaustive: never = capture.run; throw new Error('Unhandled capture run: ' + exhaustive); }
  }
  switch (capture.disposal) {
  case 'not-requested':
    if (capture.lifetime !== 'open' || capture.observation !== 'open') invalidCapture();
    break;
  case 'pending':
    if (capture.lifetime !== 'closing' || capture.observation !== 'end-requested-by-dispose') invalidCapture();
    break;
  case 'completed': case 'failed':
    if (capture.lifetime !== 'closed' || capture.observation !== 'end-requested-by-dispose') invalidCapture();
    break;
  default: { const exhaustive: never = capture.disposal; throw new Error('Unhandled capture disposal: ' + exhaustive); }
  }
}

const undefinedValue = Object.freeze({ captureValue: 'undefined' as const });
const undefinedEncodingSchema = z.object({ captureValue: z.literal('undefined') }).strict();
// A coarse input ceiling before JSON.parse, above the bounded script's escaped
// text and event metadata. It is not permission to exceed per-request limits.
export const PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS = 32 * 1024 * 1024;
const evidenceEnvelopeSchema = z.object({
  format: z.literal('production-provider-capture-evidence-v1'),
  undefinedEncoding: z.literal('capture-value-undefined-v1'),
  limits: z.object({
    scope: z.literal('per-request'),
    maximumEvents: z.literal(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumEvents),
    maximumCharacters: z.literal(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumCharacters),
    maximumFieldCharacters: z.literal(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumFieldCharacters),
  }).strict(),
  snapshot: z.unknown(),
  limitations: z.object({
    input: z.literal('fixed-synthetic-script'), providerCallbacks: z.literal('bounded-projection'),
    nativeInvocations: z.literal('not-collected-by-this-owner'), replayEligibility: z.literal('not-established'),
    realModelSuccess: z.literal('not-certified'), completeness: z.literal('projection-only-not-native-generation-correctness'),
  }).strict(),
}).strict();

function encodeTrace({ trace }: { trace: ProductionProviderTraceSnapshot }) {
  const { format, requestId, limits, completeness, failure, events, settled, lateEvents, retainedCharacters, ...rest } = trace;
  rest satisfies Record<PropertyKey, never>;
  const encodedSettlement = (() => {
    if (settled === undefined) return undefinedValue;
    const { sequence, outcome, events, completeness, failure, ...rest } = settled;
    rest satisfies Record<PropertyKey, never>;
    return { sequence, outcome, events, completeness, failure: failure ?? undefinedValue };
  })();
  return { format, requestId, limits, completeness, failure: failure ?? undefinedValue, events,
    settled: encodedSettlement, lateEvents, retainedCharacters };
}

function encodeCapture({ capture }: { capture: ProductionProviderCaptureSnapshot }) {
  const { format, runId, modelId, plan, run, lifetime, abortReason, disposal, observation, events, requests, capabilities, ...rest } = capture;
  rest satisfies Record<PropertyKey, never>;
  return { format, runId, modelId, plan, run, lifetime, abortReason: abortReason ?? undefinedValue, disposal, observation,
    events: events.map(({ sequence, kind, activeRequestId, ...rest }) => {
      rest satisfies Record<PropertyKey, never>;
      return { sequence, kind, activeRequestId: activeRequestId ?? undefinedValue };
    }),
    requests: requests.map(({ runId, requestId, scenario, status, notStartedReason, input, trace, ...rest }) => {
      rest satisfies Record<PropertyKey, never>;
      const encodedInput = (() => {
        if (input === undefined) return undefinedValue;
        const { messages, parameters, tools, ...restInput } = input;
        restInput satisfies Record<PropertyKey, never>;
        const { temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop, reasoning, ...restParameters } = parameters;
        restParameters satisfies Record<PropertyKey, never>;
        const { effort, ...restReasoning } = reasoning;
        restReasoning satisfies Record<PropertyKey, never>;
        return { messages, tools, parameters: { temperature, topP, maxCompletionTokens,
          presencePenalty: presencePenalty ?? undefinedValue, frequencyPenalty: frequencyPenalty ?? undefinedValue,
          stop: stop ?? undefinedValue, reasoning: { effort: effort ?? undefinedValue } } };
      })();
      return { runId, requestId, scenario, status, notStartedReason: notStartedReason ?? undefinedValue, input: encodedInput, trace: encodeTrace({ trace }) };
    }), capabilities };
}

/** Strict synthetic-only serialization. No recording, Provider calls, or OPFS mutation. */
export function createProductionProviderCaptureEvidence({ capture, runId, modelId }: {
  capture: ProductionProviderCaptureSnapshot; runId: string; modelId: string;
}) {
  try {
    const parsed = captureSchema.parse(capture);
    validateIdentityAndScript({ capture: parsed as ProductionProviderCaptureSnapshot, runId, modelId });
    // The schema requires these own keys even where the value is undefined.
    // Encoding reads only validated, newly allocated data, never an arbitrary replacer.
    const encoded = encodeCapture({ capture: parsed as ProductionProviderCaptureSnapshot });
    const document = evidenceEnvelopeSchema.parse({
      format: 'production-provider-capture-evidence-v1', undefinedEncoding: 'capture-value-undefined-v1',
      limits: { scope: 'per-request', ...PRODUCTION_PROVIDER_TRACE_LIMITS }, snapshot: encoded,
      limitations: {
        input: 'fixed-synthetic-script', providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner',
        replayEligibility: 'not-established', realModelSuccess: 'not-certified',
        completeness: 'projection-only-not-native-generation-correctness',
      },
    });
    const json = JSON.stringify(document, undefined, 2) + '\n';
    if (json.length > PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS) invalidCapture();
    return {
      reference: productionProviderCaptureReferenceSchema.parse({ format: 'production-provider-capture-reference-v1', path: PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH }),
      json,
    };
  } catch {
    // Do not leak Zod issue values, unknown key names, paths, or thrown messages.
    return invalidCapture();
  }
}

type DecodeField = ({ value }: { value: unknown }) => unknown;
// This mapper is used only on JSON.parse output, never on callback objects.
// Preserve unknown keys and missing keys so the shared strict schema rejects
// them; mapping must not silently sanitize or materialize absent evidence.
function decodeFields({ value, fields }: { value: unknown; fields: Record<string, DecodeField> }): Record<string, unknown> {
  const source = z.record(z.string(), z.unknown()).parse(value);
  const result = { ...source };
  for (const [key, decode] of Object.entries(fields)) if (Object.hasOwn(source, key)) result[key] = decode({ value: source[key] });
  return result;
}
function decodeMaybeUndefined({ value }: { value: unknown }): unknown {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'captureValue')) {
    undefinedEncodingSchema.parse(value);
    return undefined;
  }
  return value;
}
function decodeRequiredUndefined({ value }: { value: unknown }): undefined {
  undefinedEncodingSchema.parse(value);
  return undefined;
}
function decodeTrace({ value }: { value: unknown }): unknown {
  return decodeFields({ value, fields: {
    failure: decodeMaybeUndefined,
    settled: ({ value }) => {
      const settled = decodeMaybeUndefined({ value });
      return settled === undefined ? undefined : decodeFields({ value: settled, fields: { failure: decodeMaybeUndefined } });
    },
  } });
}
function decodeInput({ value }: { value: unknown }): unknown {
  const input = decodeMaybeUndefined({ value });
  return input === undefined ? undefined : decodeFields({ value: input, fields: {
    parameters: ({ value }) => decodeFields({ value, fields: {
      presencePenalty: decodeRequiredUndefined, frequencyPenalty: decodeRequiredUndefined, stop: decodeRequiredUndefined,
      reasoning: ({ value }) => decodeFields({ value, fields: { effort: decodeMaybeUndefined } }),
    } }),
  } });
}

/** Decode only this versioned synthetic format; no I/O or generation authority. */
export function readProductionProviderCaptureEvidence({ json, runId, modelId }: {
  json: string; runId: string; modelId: string;
}): ProductionProviderCaptureSnapshot {
  try {
    const text = z.string().max(PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS).parse(json);
    const envelope = evidenceEnvelopeSchema.parse(JSON.parse(text) as unknown);
    const decoded = decodeFields({ value: envelope.snapshot, fields: {
      abortReason: decodeMaybeUndefined,
      events: ({ value }) => z.array(z.unknown()).max(4).parse(value).map(value => decodeFields({ value, fields: { activeRequestId: decodeMaybeUndefined } })),
      requests: ({ value }) => z.array(z.unknown()).max(13).parse(value).map(value => decodeFields({ value, fields: { input: decodeInput, trace: decodeTrace, notStartedReason: decodeMaybeUndefined } })),
    } });
    const parsed = captureSchema.parse(decoded);
    validateIdentityAndScript({ capture: parsed as ProductionProviderCaptureSnapshot, runId, modelId });
    // Same validated bridge as export: strictRecord requires own keys even for
    // undefined values, while Zod's output type marks those keys optional.
    // No assertion is applied to raw JSON or to a merely decoded object.
    return parsed as ProductionProviderCaptureSnapshot;
  } catch {
    return invalidCapture();
  }
}

export const TEST_ONLY = {
};
