import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import { toToolCallId, toMessageId, toAttachmentId, toBinaryObjectId } from '@/01-models/ids';
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE as image } from '@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image';
import { MODEL_SUPPORT_TOOL_RESULT_CONTENT } from './tool-protocol-fixture';
import type { CaptureAssistantPart, ProductionProviderSettledSnapshot } from './production-provider-trace';

export const legacyCapturePlanSchema = z.enum(['first-only', 'first-continuity-independent']);
export const fixedCapturePlanV2Schema = z.enum(['generation-v2', 'generation-continuity-v2', 'generation-capabilities-v2', 'full-v2']);
export const capturePlanSchema = z.union([legacyCapturePlanSchema, fixedCapturePlanV2Schema]);
export type ProductionProviderCapturePlan = z.infer<typeof capturePlanSchema>;
export const captureScenarioSchema = z.enum([
  'first-turn', 'continuity', 'independent-next-input', 'system-user', 'supplied-history',
  'reasoning-none', 'reasoning-low', 'reasoning-medium', 'reasoning-high',
  'natural-tool-minimal', 'natural-tool-representative', 'structured-tool-history', 'image',
]);
export type CaptureScenario = z.infer<typeof captureScenarioSchema>;
const fullScenarios = Object.freeze([...captureScenarioSchema.options]);
export type CaptureMessage =
  | Readonly<{ role: 'assistant'; parts: readonly CaptureAssistantPart[] }>
  | Readonly<{ role: 'user' | 'assistant' | 'system'; content: string }>
  | Readonly<{ role: 'user'; content: readonly [Readonly<{ type: 'text'; text: string }>, Readonly<{ type: 'image_url'; image_url: Readonly<{ url: string }> }>] }>
  | Readonly<{ role: 'assistant'; content: ''; tool_calls: readonly [Readonly<{ id: 'call_model_support_probe_1'; type: 'function'; function: Readonly<{ name: 'lookup_weather'; arguments: '{"city":"Tokyo"}' }> }>] }>
  | Readonly<{ role: 'tool'; content: string; tool_call_id: 'call_model_support_probe_1' }>;
export type CaptureParameters = Readonly<{
  temperature: 0; topP: 1; maxCompletionTokens: 16 | 1 | 128;
  presencePenalty: undefined; frequencyPenalty: undefined; stop: undefined;
  reasoning: Readonly<{ effort: 'none' | 'low' | 'medium' | 'high' | undefined }>;
}>;
export interface CaptureRequestInput {
  readonly messages: readonly CaptureMessage[];
  readonly parameters: CaptureParameters;
  // An inert fixed Tool identity/projection, never a deserialized executable.
  readonly tools: readonly [] | readonly [Readonly<{
    fixtureId: 'model-support-weather-v1'; name: 'lookup_weather';
    description: 'Return deterministic weather fixture data.';
    parameters: Readonly<{ type: 'object'; properties: Readonly<{ city: Readonly<{ type: 'string' }> }>; required: readonly ['city']; additionalProperties: false }>;
  }>];
}

export function isCapturePlanV2({ plan }: { plan: ProductionProviderCapturePlan }): boolean {
  switch (plan) {
  case 'first-only': case 'first-continuity-independent': return false;
  case 'generation-v2': case 'generation-continuity-v2': case 'generation-capabilities-v2': case 'full-v2': return true;
  default: { const exhaustive: never = plan; throw new Error('Unhandled capture plan: ' + exhaustive); }
  }
}

/** Fixed rows remain present in v2 so scope exclusion is not a failed attempt. */
export function captureScenarios({ plan }: { plan: ProductionProviderCapturePlan }): readonly CaptureScenario[] {
  switch (plan) {
  case 'first-only': return ['first-turn'];
  case 'first-continuity-independent': return ['first-turn', 'continuity', 'independent-next-input'];
  case 'generation-v2': case 'generation-continuity-v2': case 'generation-capabilities-v2': case 'full-v2': return fullScenarios;
  default: { const exhaustive: never = plan; throw new Error('Unhandled capture plan: ' + exhaustive); }
  }
}

export function isCaptureScenarioSelected({ plan, scenario }: { plan: ProductionProviderCapturePlan; scenario: CaptureScenario }): boolean {
  if (!isCapturePlanV2({ plan })) return captureScenarios({ plan }).includes(scenario);
  switch (scenario) {
  case 'first-turn': case 'system-user': case 'supplied-history': return true;
  case 'continuity': case 'independent-next-input': return plan === 'generation-continuity-v2' || plan === 'full-v2';
  case 'reasoning-none': case 'reasoning-low': case 'reasoning-medium': case 'reasoning-high':
  case 'natural-tool-minimal': case 'natural-tool-representative': case 'structured-tool-history': case 'image':
    return plan === 'generation-capabilities-v2' || plan === 'full-v2';
  default: { const exhaustive: never = scenario; throw new Error('Unhandled capture scenario: ' + exhaustive); }
  }
}

/** The fixed continuity script has exactly one assistant history slot. Do not
 * replace an unexpected tool conversation with just its final text. */
export function isCapturedContinuityAvailable({ settled }: { settled: ProductionProviderSettledSnapshot | undefined }): boolean {
  if (settled?.outcome.status !== 'fulfilled' || settled.completeness !== 'complete') return false;
  const assistants = settled.events.filter(event => event.kind === 'assistant_message');
  // Old archives were captured as literal callbacks; do not infer missing parts.
  if (assistants.length === 0) return true;
  return assistants.length === 1 && !settled.events.some(event => [
    'part_call', 'tool-started', 'tool-output', 'tool-exit', 'tool-success', 'tool-error',
  ].includes(event.kind));
}

/** Fixed public input only. Never reads native output or repairs late callbacks. */
export function captureScenarioInput({ scenario, firstSettled }: {
  scenario: CaptureScenario; firstSettled: ProductionProviderSettledSnapshot | undefined;
}): CaptureRequestInput {
  let messages: CaptureMessage[];
  let maxCompletionTokens: CaptureParameters['maxCompletionTokens'] = 1;
  let effort: CaptureParameters['reasoning']['effort'];
  let tools: CaptureRequestInput['tools'] = Object.freeze([] as const);
  switch (scenario) {
  case 'first-turn': messages = [{ role: 'user', content: 'Template probe user message.' }]; maxCompletionTokens = 16; break;
  case 'continuity': {
    if (firstSettled === undefined || !isCapturedContinuityAvailable({ settled: firstSettled })) throw new Error('Continuity requires complete first settlement representable by the fixed script');
    const observed = captureSettledAssistantParts({ settled: firstSettled });
    const assistant: CaptureMessage = observed === undefined
      // Legacy captures remain literal text; do not fabricate part boundaries or reasoning.
      ? { role: 'assistant', content: firstSettled.events.filter(event => event.kind === 'chunk').map(event => event.chunk).join('') }
      : { role: 'assistant', parts: observed };
    messages = [{ role: 'user', content: 'Template probe user message.' }, assistant, { role: 'user', content: 'Continue the synthetic conversation with a short response.' }];
    maxCompletionTokens = 16;
    break;
  }
  case 'independent-next-input': messages = [{ role: 'user', content: 'A separate synthetic capture conversation.' }]; break;
  case 'system-user': messages = [{ role: 'system', content: 'Template probe system instruction.' }, { role: 'user', content: 'Template probe user message.' }]; break;
  case 'supplied-history': messages = [{ role: 'user', content: 'Template probe first user message.' }, { role: 'assistant', content: 'Template probe assistant response.' }, { role: 'user', content: 'Template probe second user message.' }]; break;
  case 'reasoning-none': effort = 'none'; messages = [{ role: 'user', content: 'Template probe user message.' }]; break;
  case 'reasoning-low': effort = 'low'; messages = [{ role: 'user', content: 'Template probe user message.' }]; break;
  case 'reasoning-medium': effort = 'medium'; messages = [{ role: 'user', content: 'Template probe user message.' }]; break;
  case 'reasoning-high': effort = 'high'; messages = [{ role: 'user', content: 'Template probe user message.' }]; break;
  case 'natural-tool-minimal': messages = [{ role: 'user', content: 'Use the weather tool for Tokyo.' }]; break;
  case 'natural-tool-representative': messages = [{ role: 'user', content: 'Use lookup_weather for Tokyo, then give a short answer based on the tool result.' }]; break;
  case 'structured-tool-history': messages = [
    { role: 'user', content: 'Use the weather tool for Tokyo.' },
    { role: 'assistant', content: '', tool_calls: Object.freeze([Object.freeze({ id: 'call_model_support_probe_1', type: 'function', function: Object.freeze({ name: 'lookup_weather', arguments: '{"city":"Tokyo"}' }) })] as const) },
    { role: 'tool', tool_call_id: 'call_model_support_probe_1', content: MODEL_SUPPORT_TOOL_RESULT_CONTENT },
  ]; break;
  case 'image': messages = [{ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: image.prompt }), Object.freeze({ type: 'image_url', image_url: Object.freeze({ url: image.dataUrl }) })] as const) }]; break;
  default: { const exhaustive: never = scenario; throw new Error('Unhandled capture scenario: ' + exhaustive); }
  }
  if (scenario === 'natural-tool-minimal' || scenario === 'natural-tool-representative' || scenario === 'structured-tool-history') {
    // Per native invocation, not a tool-loop count or whole-script deadline.
    maxCompletionTokens = 128;
    tools = Object.freeze([Object.freeze({ fixtureId: 'model-support-weather-v1', name: 'lookup_weather', description: 'Return deterministic weather fixture data.', parameters: Object.freeze({ type: 'object', properties: Object.freeze({ city: Object.freeze({ type: 'string' }) }), required: Object.freeze(['city'] as const), additionalProperties: false }) })] as const);
  }
  return Object.freeze({ messages: Object.freeze(messages.map(message => Object.freeze(message))), tools,
    parameters: Object.freeze({ temperature: 0, topP: 1, maxCompletionTokens, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: Object.freeze({ effort }) }),
  });
}

/** Rebuild only the applied parts of the last observed assistant, never late events. */
export function captureSettledAssistantParts({ settled }: { settled: ProductionProviderSettledSnapshot }): readonly CaptureAssistantPart[] | undefined {
  let messageId: string | undefined;
  const parts = new Map<string, { index: number; part: CaptureAssistantPart }>();
  for (const event of settled.events) {
    switch (event.kind) {
    case 'assistant_message': messageId = event.messageId; parts.clear(); break;
    case 'part_text':
      if (event.messageId !== messageId) throw new Error('Part outside its captured assistant');
      parts.set(event.partId, { index: event.index, part: Object.freeze({ id: event.partId, type: event.partType, text: event.text, completeness: event.completeness }) });
      break;
    case 'part_call':
      if (event.messageId !== messageId) throw new Error('Call outside its captured assistant');
      parts.set(event.partId, { index: event.index, part: Object.freeze({ id: event.partId, type: 'tool_call', toolCall: Object.freeze({ id: event.toolCallId, type: 'function', function: Object.freeze({ name: event.toolName, arguments: event.modelVisibleArguments }) }) }) });
      break;
    case 'chunk': case 'assistant-start': case 'tool-call': case 'tool-started': case 'tool-output': case 'tool-exit': case 'tool-success': case 'tool-error':
    case 'generation_finished': case 'generation_interrupted': case 'generation_error': break;
    default: { const exhaustive: never = event; throw new Error('Unhandled capture event: ' + exhaustive); }
    }
  }
  if (messageId === undefined) return undefined;
  const ordered = [...parts.values()].sort((a, b) => a.index - b.index);
  if (ordered.some((entry, index) => entry.index !== index)) throw new Error('Incomplete part ordering in captured assistant');
  return Object.freeze(ordered.map(entry => entry.part));
}

/** Materialize the archived synthetic inputs as an independent application history.
 * The archive format is not the public chat API and is not rewritten on read. */
export function captureProviderMessages({ input }: { input: CaptureRequestInput }): ChatMessage[] {
  return input.messages.map((message, index): ChatMessage => {
    const id = toMessageId({ raw: `capture_input_${index}` });
    if ('parts' in message) {
      const { role, parts, ...rest } = message; rest satisfies Record<PropertyKey, never>;
      return { id, role, parts: parts.map(part => {
        switch (part.type) {
        case 'text': case 'reasoning': {
          const { id, type, text, completeness, ...rest } = part; rest satisfies Record<PropertyKey, never>;
          return { id, type, text, completeness };
        }
        case 'tool_call': {
          const { id, type, toolCall, ...rest } = part; rest satisfies Record<PropertyKey, never>;
          const { id: callId, type: callType, function: fn, ...restCall } = toolCall; restCall satisfies Record<PropertyKey, never>;
          const { name, arguments: args, ...restFunction } = fn; restFunction satisfies Record<PropertyKey, never>;
          return { id, type, toolCall: { id: toToolCallId({ raw: callId }), type: callType, function: { name, arguments: args } } };
        }
        default: { const exhaustive: never = part; throw new Error('Unhandled captured assistant part: ' + exhaustive); }
        }
      }) };
    }
    if ('tool_calls' in message) {
      const { role, content, tool_calls, ...rest } = message; rest satisfies Record<PropertyKey, never>;
      return { id, role, parts: [
        { id: 'text_0', type: 'text', text: content, completeness: 'complete' },
        ...tool_calls.map(({ id, type, function: fn, ...rest }, callIndex) => {
          rest satisfies Record<PropertyKey, never>;
          const { name, arguments: args, ...restFunction } = fn; restFunction satisfies Record<PropertyKey, never>;
          return { id: `tool_call_${callIndex}`, type: 'tool_call' as const,
            toolCall: { id: toToolCallId({ raw: id }), type, function: { name, arguments: args } } };
        }),
      ] };
    }
    if ('tool_call_id' in message) {
      const { role, content, tool_call_id, ...rest } = message; rest satisfies Record<PropertyKey, never>;
      return { id, role, parts: [{ id: 'tool_result_0', type: 'tool_result', result: {
        toolCallId: toToolCallId({ raw: tool_call_id }), status: 'success', content: { type: 'text', text: content },
      } }] };
    }
    const { role, content, ...rest } = message; rest satisfies Record<PropertyKey, never>;
    if (typeof content === 'string') return { id, role, parts: [{ id: 'text_0', type: 'text', text: content, completeness: 'complete' }] };
    switch (role) {
    case 'user': break;
    case 'assistant': case 'system': throw new Error('Only the fixed user input can contain an image');
    default: { const exhaustive: never = role; throw new Error('Unhandled capture role: ' + exhaustive); }
    }
    return { id, role, parts: content.map((part, partIndex) => {
      switch (part.type) {
      case 'text': {
        const { type, text, ...rest } = part; rest satisfies Record<PropertyKey, never>;
        return { id: `text_${partIndex}`, type, text, completeness: 'complete' };
      }
      case 'image_url': {
        const { type: _type, image_url, ...rest } = part; rest satisfies Record<PropertyKey, never>;
        const { url, ...restImage } = image_url; restImage satisfies Record<PropertyKey, never>;
        // This capture may materialize only its embedded public image, never fetch
        // an archive-supplied URL or grant the production worker network access.
        if (url !== image.dataUrl) throw new Error('Unknown capture image fixture');
        const bytes = Uint8Array.from(atob(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)), character => character.charCodeAt(0));
        const blob = new Blob([bytes], { type: image.mimeType });
        return { id: `attachment_${partIndex}`, type: 'attachment', attachment: {
          id: toAttachmentId({ raw: 'capture_image' }), binaryObjectId: toBinaryObjectId({ raw: image.fixtureId }),
          originalName: 'capture.png', mimeType: image.mimeType, size: blob.size, uploadedAt: 0, status: 'memory', blob,
        } };
      }
      default: { const exhaustive: never = part; throw new Error('Unhandled capture part: ' + exhaustive); }
      }
    }) };
  });
}

export const TEST_ONLY = {
};
