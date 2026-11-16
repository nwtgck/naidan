// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { speechInvestigationEnvelopeSchema, createWorkerSpeechInvestigationObserver } from './investigation-protocol';

it('validates closed event data and the explicit investigation source without a function RPC', () => {
  const context = { operationId: 'run-id', source: 'investigation' };
  const value = { type: 'naidan_speech_investigation_v1', context, event: { kind: 'wasm_heap', capacityBytes: 65536 } };
  expect(speechInvestigationEnvelopeSchema.safeParse(value).success).toBe(true);
  expect(speechInvestigationEnvelopeSchema.safeParse({ ...value, context: { ...context, source: 'normal' } }).success).toBe(false);
  expect(speechInvestigationEnvelopeSchema.safeParse({ ...value, event: { kind: 'unregistered', value: 1 } }).success).toBe(false);
  expect(speechInvestigationEnvelopeSchema.safeParse({ ...value, event: { kind: 'native_log_batch', lines: [{ level: 'info', text: 'x'.repeat(8193) }], dropped: 0 } }).success).toBe(false);
});

it('sends only a bounded typed notification for an explicit operation and sends nothing when off', () => {
  const post = vi.fn();
  vi.stubGlobal('postMessage', post);
  using globals = {
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
  expect(createWorkerSpeechInvestigationObserver({ context: undefined })).toBeUndefined();
  expect(post).not.toHaveBeenCalled();
  const observer = createWorkerSpeechInvestigationObserver({ context: { operationId: 'active-run', source: 'investigation' } })!;
  observer({ event: { kind: 'wasm_heap', capacityBytes: 65536 } });
  expect(post).toHaveBeenCalledWith({ type: 'naidan_speech_investigation_v1', context: { operationId: 'active-run', source: 'investigation' }, event: { kind: 'wasm_heap', capacityBytes: 65536 } });
  void globals;
});
