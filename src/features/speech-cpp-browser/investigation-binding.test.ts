// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSpeechInvestigationBindings } from './investigation-binding';

it('routes operation IDs locally and does not let an old load release detach its first run', () => {
  const bindings = createSpeechInvestigationBindings(), load = vi.fn(), run = vi.fn();
  const context = { operationId: 'same-attempt', source: 'investigation' as const }, event = { kind: 'wasm_heap' as const, capacityBytes: 65536 };
  expect(bindings.bind({ binding: undefined })).toBeUndefined();
  const loading = bindings.bind({ binding: { context, observer: load } })!;
  bindings.receive({ context, event });
  const running = bindings.bind({ binding: { context, observer: run } })!;
  loading.release();
  bindings.receive({ context, event });
  bindings.receive({ context: { ...context, operationId: 'unrelated' }, event });
  expect(load).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  running.release();
  bindings.receive({ context, event });
  expect(run).toHaveBeenCalledOnce();
});
