import { describe, expect, it } from 'vitest';
import { isUnsupportedReasoningError, UnsupportedReasoningError } from '@/01-models/lm-errors';
import { isReasoningErrorEnvelope, isReasoningRejection, renderThinkingTemplate } from './reasoning-rejection';

describe('positive reasoning rejection classification', () => {
  it.each([
    'This model does not support disabling thinking',
    'enable_thinking must be true',
    'Cannot disable thinking for this model',
    'Thinking is not supported by this template',
  ])('classifies an explicit template rejection: %s', message => {
    expect(() => renderThinkingTemplate({
      offRequested: true,
      render: () => {
        throw new Error(message);
      },
    })).toThrow(UnsupportedReasoningError);
  });

  it('does not classify a generic template failure or a failure without an off request', () => {
    for (const offRequested of [true, false]) {
      const error = new Error('Unsupported system role');
      expect(() => renderThinkingTemplate({
        offRequested,
        render: () => {
          throw error;
        },
      })).toThrow(error);
    }
    const error = new Error('Thinking is not supported');
    try {
      renderThinkingTemplate({
        offRequested: false,
        render: () => {
          throw error;
        },
      });
    } catch (caught) {
      expect(caught).toBe(error);
      expect(isUnsupportedReasoningError({ error: caught })).toBe(false);
    }
  });

  it('preserves native traps, even with misleading error text', () => {
    const trap = new WebAssembly.RuntimeError('Thinking is not supported');
    try {
      renderThinkingTemplate({
        offRequested: true,
        render: () => {
          throw trap;
        },
      });
    } catch (error) {
      expect(error).toBe(trap);
      expect(isUnsupportedReasoningError({ error })).toBe(false);
    }
  });

  it('recognizes the named Error reconstructed by a worker transport', () => {
    const original = new UnsupportedReasoningError({ message: 'Unsupported thinking' });
    const reconstructed = new Error(original.message);
    reconstructed.name = original.name;
    expect(reconstructed).not.toBeInstanceOf(UnsupportedReasoningError);
    expect(isUnsupportedReasoningError({ error: reconstructed })).toBe(true);
  });

  it.each(['invalid_value', 'invalid_enum_value', 'invalid_type'])('recognizes a structured %s identifying the reasoning parameter', code => {
    expect(isReasoningErrorEnvelope({
      value: {
        error: {
          code,
          param: 'reasoning_effort',
          message: "Expected one of 'low', 'medium', 'high'.",
        },
      },
      parameter: 'reasoning_effort',
    })).toBe(true);
    expect(isReasoningErrorEnvelope({
      value: {
        error: {
          code,
          param: 'model',
          message: 'Invalid model.',
        },
      },
      parameter: 'reasoning_effort',
    })).toBe(false);
  });

  it.each([null, 'error', {}, { choices: [{ delta: { content: 'Title' } }] }])('ignores ordinary streaming data: %j', value => {
    expect(isReasoningErrorEnvelope({ value, parameter: 'reasoning_effort' })).toBe(false);
  });

  it('does not reinterpret a streaming rate-limit code as a reasoning validation failure', () => {
    expect(isReasoningErrorEnvelope({ value: { error: { code: 'rate_limit_exceeded', message: 'reasoning_effort is not supported', param: 'reasoning_effort' } }, parameter: 'reasoning_effort' })).toBe(false);
  });

  it('rejects malformed envelopes and non-JSON error bodies', async () => {
    for (const response of [new Response('HTML error', { status: 400 }), Response.json({ error: { param: 'reasoning_effort' } }, { status: 400 })]) {
      expect(await isReasoningRejection({ response, parameter: 'reasoning_effort' })).toBe(false);
    }
  });
});
