import { describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import { toToolCallId } from '@/01-models/ids';
import { createProductionProviderTrace } from './production-provider-trace';

const toolCallId = toToolCallId({ raw: 'synthetic-call' });

describe('bounded synchronous Production Provider trace', () => {
  it('records the actual configured limits without retaining the caller configuration', () => {
    const limits = { maximumEvents: 1, maximumCharacters: 3 };
    const trace = createProductionProviderTrace({ requestId: 'configured-limits', limits });
    limits.maximumEvents = 4096;
    limits.maximumCharacters = 262144;
    trace.callbacks.onChunk({ chunk: 'abc' });
    trace.callbacks.onChunk({ chunk: 'd' });
    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({
      format: 'production-provider-trace-v2',
      limits: { maximumEvents: 1, maximumCharacters: 3, maximumFieldCharacters: 16384 },
      retainedCharacters: 3,
      failure: { reason: 'event-limit', phase: 'before-settlement', sequence: 1 },
    });
    expect(snapshot.events).toEqual([{ kind: 'chunk', chunk: 'abc', phase: 'before-settlement', sequence: 0 }]);
    expect(Object.isFrozen(snapshot.limits)).toBe(true);
  });

  it('records character budgets in UTF-16 code units rather than encoded bytes', () => {
    const trace = createProductionProviderTrace({ requestId: 'utf16-limits', limits: { maximumEvents: 10, maximumCharacters: 2 } });
    trace.callbacks.onChunk({ chunk: '😀' });
    trace.callbacks.onChunk({ chunk: 'x' });
    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({
      limits: { maximumEvents: 10, maximumCharacters: 2, maximumFieldCharacters: 16384 },
      retainedCharacters: 2,
      failure: { reason: 'character-limit', phase: 'before-settlement', sequence: 1 },
    });
    expect(snapshot.events).toEqual([{ kind: 'chunk', chunk: '😀', phase: 'before-settlement', sequence: 0 }]);
  });

  it('records callback order synchronously and separates callbacks after the direct await', async () => {
    const trace = createProductionProviderTrace({ requestId: 'synthetic-request', limits: { maximumEvents: 20, maximumCharacters: 1024 } });
    // This fixture checks the LmProvider callback boundary, not real service or Comlink timing.
    const provider: LmProvider = {
      async chat({ onChunk, onAssistantMessageStart }) {
        expect(onAssistantMessageStart?.()).toBeUndefined();
        expect(onChunk({ chunk: '' })).toBeUndefined();
        expect(onChunk({ chunk: 'first' })).toBeUndefined();
        expect(trace.snapshot().events.map(event => event.kind)).toEqual(['assistant-start', 'chunk', 'chunk']);
      },
      async listModels() {
        return [];
      },
    };
    await provider.chat({ model: 'synthetic/model', messages: [], ...trace.callbacks });
    const settled = trace.settle({ outcome: 'fulfilled', error: undefined });
    trace.callbacks.onChunk({ chunk: '-late' });
    const snapshot = trace.snapshot();
    expect(settled.outcome).toEqual({ status: 'fulfilled' });
    expect(settled.sequence).toBe(3);
    expect(settled.events).toHaveLength(3);
    expect(snapshot.events).toBe(settled.events);
    expect(snapshot.lateEvents).toEqual([{ kind: 'chunk', chunk: '-late', phase: 'after-settlement', sequence: 4 }]);
    expect(settled.events.every(event => event.phase === 'before-settlement')).toBe(true);
  });

  it('projects all public tool callbacks without retaining mutable tool objects', () => {
    const trace = createProductionProviderTrace({ requestId: 'synthetic-tools', limits: { maximumEvents: 20, maximumCharacters: 1024 } });
    const call = { id: toolCallId, toolName: 'synthetic_echo', modelVisibleArguments: '{"text":"fixture"}' };
    const output = { type: 'output' as const, stream: 'stdout' as const, text: 'fixture-output' };
    const result = { status: 'success' as const, content: 'fixture-result' };
    expect(trace.callbacks.onToolCall(call)).toBeUndefined();
    trace.callbacks.onToolEvent({ id: toolCallId, event: { type: 'started' } });
    trace.callbacks.onToolEvent({ id: toolCallId, event: output });
    trace.callbacks.onToolEvent({ id: toolCallId, event: { type: 'exit', exitCode: 0 } });
    trace.callbacks.onToolResult({ id: toolCallId, result });
    const snapshot = trace.snapshot();
    call.toolName = 'mutated'; output.text = 'mutated'; result.content = 'mutated';
    expect(snapshot.events.map(event => event.kind)).toEqual(['tool-call', 'tool-started', 'tool-output', 'tool-exit', 'tool-success']);
    expect(snapshot.events[0]).toMatchObject({ toolName: 'synthetic_echo', modelVisibleArguments: '{"text":"fixture"}' });
    expect(snapshot.events[2]).toMatchObject({ text: 'fixture-output', stream: 'stdout' });
    expect(snapshot.events[4]).toMatchObject({ content: 'fixture-result' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(snapshot.events.every(Object.isFrozen)).toBe(true);
  });

  it('keeps an earlier snapshot immutable while two requests interleave', () => {
    const first = createProductionProviderTrace({ requestId: 'request-one', limits: { maximumEvents: 10, maximumCharacters: 100 } });
    const second = createProductionProviderTrace({ requestId: 'request-two', limits: { maximumEvents: 10, maximumCharacters: 100 } });
    first.callbacks.onChunk({ chunk: 'one' });
    const pendingSnapshot = first.snapshot();
    first.callbacks.onChunk({ chunk: '-before' });
    const settled = first.settle({ outcome: 'fulfilled', error: undefined });
    second.callbacks.onChunk({ chunk: 'two' });
    first.callbacks.onChunk({ chunk: '-late' });
    expect(pendingSnapshot.events).toHaveLength(1);
    expect(pendingSnapshot.settled).toBeUndefined();
    expect(settled.events).toHaveLength(2);
    expect(second.snapshot().events).toEqual([{ kind: 'chunk', chunk: 'two', phase: 'before-settlement', sequence: 0 }]);
    expect(second.snapshot().lateEvents).toHaveLength(0);
    expect(first.snapshot().requestId).toBe('request-one');
    expect(first.snapshot().lateEvents).toHaveLength(1);
  });

  it('latches event overflow without growing further or losing fulfilled settlement', async () => {
    const trace = createProductionProviderTrace({ requestId: 'event-overflow', limits: { maximumEvents: 1, maximumCharacters: 100 } });
    const provider: LmProvider = {
      async chat({ onChunk }) {
        onChunk({ chunk: 'kept' });
        for (let index = 0; index < 100; index += 1) onChunk({ chunk: 'dropped' });
      },
      async listModels() {
        return [];
      },
    };
    await expect(provider.chat({ model: 'synthetic/model', messages: [], ...trace.callbacks })).resolves.toBeUndefined();
    const settled = trace.settle({ outcome: 'fulfilled', error: undefined });
    expect(settled.outcome.status).toBe('fulfilled');
    expect(settled.completeness).toBe('incomplete');
    expect(settled.failure).toEqual({ reason: 'event-limit', phase: 'before-settlement', sequence: 1 });
    const before = trace.snapshot();
    trace.callbacks.onChunk({ get chunk(): string {
      throw new Error('Must not inspect callbacks after overflow');
    } });
    expect(trace.snapshot()).toEqual(before);
  });

  it('does not retroactively mark the settled snapshot incomplete after late overflow', () => {
    const trace = createProductionProviderTrace({ requestId: 'late-overflow', limits: { maximumEvents: 1, maximumCharacters: 10 } });
    trace.callbacks.onChunk({ chunk: 'early' });
    const settled = trace.settle({ outcome: 'fulfilled', error: undefined });
    trace.callbacks.onChunk({ chunk: 'late' });
    expect(settled.completeness).toBe('complete');
    expect(settled.failure).toBeUndefined();
    expect(trace.snapshot().failure).toEqual({ reason: 'event-limit', phase: 'after-settlement', sequence: 2 });
    expect(trace.snapshot().completeness).toBe('incomplete');
    expect(trace.snapshot().lateEvents).toHaveLength(0);
  });

  it('retains a public rejection after exhausting the recording budget', async () => {
    const trace = createProductionProviderTrace({ requestId: 'rejected-overflow', limits: { maximumEvents: 0, maximumCharacters: 0 } });
    const original = new Error('Synthetic provider rejection');
    const provider: LmProvider = {
      async chat({ onChunk }) {
        onChunk({ chunk: 'not retained' }); throw original;
      },
      async listModels() {
        return [];
      },
    };
    let caught: unknown;
    try {
      await provider.chat({ model: 'synthetic/model', messages: [], ...trace.callbacks });
      trace.settle({ outcome: 'fulfilled', error: undefined });
    } catch (error) {
      trace.settle({ outcome: 'rejected', error });
      caught = error;
    }
    expect(caught).toBe(original);
    expect(trace.snapshot().settled).toMatchObject({ completeness: 'incomplete', outcome: { status: 'rejected' }, failure: { reason: 'event-limit' } });
    expect(trace.snapshot().events).toHaveLength(0);
  });

  it('accounts for all retained string fields and rejects oversized events without partial records', () => {
    const trace = createProductionProviderTrace({ requestId: 'character-overflow', limits: { maximumEvents: 10, maximumCharacters: 5 } });
    trace.callbacks.onChunk({ chunk: 'abcd' });
    trace.callbacks.onChunk({ chunk: 'ef' });
    expect(trace.snapshot().retainedCharacters).toBe(4);
    expect(trace.snapshot().events).toHaveLength(1);
    expect(trace.snapshot().failure?.reason).toBe('character-limit');
    const toolTrace = createProductionProviderTrace({ requestId: 'tool-character-overflow', limits: { maximumEvents: 10, maximumCharacters: 20 } });
    toolTrace.callbacks.onToolCall({ id: toolCallId, toolName: 'echo', modelVisibleArguments: '123456' });
    expect(toolTrace.snapshot().failure?.reason).toBe('character-limit');
    expect(toolTrace.snapshot().events).toHaveLength(0);
    expect(toolTrace.snapshot().retainedCharacters).toBe(0);
  });

  it('enforces the per-field ceiling even when the total budget is larger', () => {
    const trace = createProductionProviderTrace({ requestId: 'field-overflow', limits: { maximumEvents: 10, maximumCharacters: 262144 } });
    trace.callbacks.onChunk({ chunk: 'x'.repeat(16385) });
    expect(trace.snapshot().failure?.reason).toBe('character-limit');
    expect(trace.snapshot().events).toHaveLength(0);
  });

  it('does not execute callback getters and cannot turn public fulfillment into rejection', async () => {
    const getter = vi.fn(() => {
      throw new Error('Getter must never execute');
    });
    const trace = createProductionProviderTrace({ requestId: 'getter', limits: { maximumEvents: 10, maximumCharacters: 100 } });
    const input = Object.defineProperty({}, 'chunk', { get: getter }) as { chunk: string };
    const provider: LmProvider = {
      async chat({ onChunk }) {
        onChunk(input);
      },
      async listModels() {
        return [];
      },
    };
    await expect(provider.chat({ model: 'synthetic/model', messages: [], ...trace.callbacks })).resolves.toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(trace.settle({ outcome: 'fulfilled', error: undefined })).toMatchObject({ completeness: 'incomplete', outcome: { status: 'fulfilled' } });
  });

  it('rejects nested accessor fields without evaluating them', () => {
    const getter = vi.fn(() => 'secret');
    const trace = createProductionProviderTrace({ requestId: 'nested-getter', limits: { maximumEvents: 10, maximumCharacters: 100 } });
    trace.callbacks.onToolEvent({ id: toolCallId, event: { type: 'output', stream: 'stdout', get text() {
      return getter();
    } } });
    expect(getter).not.toHaveBeenCalled();
    expect(trace.snapshot().failure?.reason).toBe('unreadable-callback');
  });

  it('contains descriptor-trap sink failure while preserving the original public rejection', async () => {
    const original = new Error('Original provider failure');
    const trace = createProductionProviderTrace({ requestId: 'sink-failure', limits: { maximumEvents: 10, maximumCharacters: 100 } });
    const provider: LmProvider = {
      async chat({ onChunk }) {
        onChunk(new Proxy({ chunk: 'fixture' }, { getOwnPropertyDescriptor() {
          throw new Error('Observer failure');
        } }));
        throw original;
      },
      async listModels() {
        return [];
      },
    };
    let caught: unknown;
    try {
      await provider.chat({ model: 'synthetic/model', messages: [], ...trace.callbacks });
      trace.settle({ outcome: 'fulfilled', error: undefined });
    } catch (error) {
      trace.settle({ outcome: 'rejected', error });
      caught = error;
    }
    expect(caught).toBe(original);
    expect(trace.snapshot().settled).toMatchObject({ completeness: 'incomplete', outcome: { status: 'rejected', errorName: 'unknown' } });
  });

  it('omits arbitrary tool/error fields and never calls their serialization or error-name getters', () => {
    const getter = vi.fn(() => 'Error');
    const toJSON = vi.fn(() => {
      throw new Error('Do not serialize live objects');
    });
    const trace = createProductionProviderTrace({ requestId: 'privacy', limits: { maximumEvents: 10, maximumCharacters: 100 } });
    const result = { status: 'error' as const, code: 'execution_failed' as const, message: '/private/local/path', stack: 'raw-stack', environment: 'private-environment', toJSON };
    trace.callbacks.onToolResult({ id: toolCallId, result });
    const error = Object.defineProperty({ stack: 'raw-stack', message: '/private/local/path', toJSON }, 'name', { get: getter });
    const settled = trace.settle({ outcome: 'rejected', error });
    expect(settled.outcome).toEqual({ status: 'rejected', errorName: 'unknown' });
    expect(settled.events[0]).toMatchObject({ kind: 'tool-error', code: 'execution_failed', messageCapture: 'omitted-for-privacy' });
    expect(JSON.stringify(trace.snapshot())).not.toMatch(/private|raw-stack/);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('retains only allowlisted own error names and rejects duplicate settlement without changing the first result', () => {
    const trace = createProductionProviderTrace({ requestId: 'rejection-name', limits: { maximumEvents: 0, maximumCharacters: 0 } });
    const error = new Error('Not captured');
    Object.defineProperty(error, 'name', { value: 'AbortError' });
    const settled = trace.settle({ outcome: 'rejected', error });
    expect(settled.outcome).toEqual({ status: 'rejected', errorName: 'AbortError' });
    expect(trace.settle({ outcome: 'fulfilled', error: undefined })).toBe(settled);
    expect(settled.completeness).toBe('complete');
    expect(trace.snapshot().failure?.reason).toBe('duplicate-settlement');
  });

  it('rejects unbounded configuration before collecting any callbacks', () => {
    expect(() => createProductionProviderTrace({ requestId: 'fixture', limits: { maximumEvents: Infinity, maximumCharacters: 100 } })).toThrow();
    expect(() => createProductionProviderTrace({ requestId: 'fixture', limits: { maximumEvents: 4097, maximumCharacters: 100 } })).toThrow();
    expect(() => createProductionProviderTrace({ requestId: 'fixture', limits: { maximumEvents: 10, maximumCharacters: 262145 } })).toThrow();
    expect(() => createProductionProviderTrace({ requestId: '/private/path', limits: { maximumEvents: 10, maximumCharacters: 100 } })).toThrow();
  });
});
