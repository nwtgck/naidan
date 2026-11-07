import { it, expect, vi } from 'vitest';
import { toolExecutionFixture } from './tool-execution.test-support';
import { readText } from './values';
import type { WorkflowToolExecution } from './tool-execution';

it('spools tool text and retains structured metadata without persisting approval', async () => {
  await using test = toolExecutionFixture({ name: 'wikipedia_search', onError: 'fail' });
  test.execute.mockResolvedValue({ outcome: { status: 'success', content: 'lang\tpageId\ttitle\nen\t12\tExample' }, metadata: { items: [{ lang: 'en', pageId: 12, title: 'Example' }] } });
  const outputs = await test.run();
  expect(outputs.text?.type).toBe('text');
  expect(await readText({ value: outputs.text!, signal: undefined, maxBytes: 4096 })).toContain('en\t12\tExample');
  expect(outputs.ok).toEqual({ type: 'json', value: true });
  expect(outputs.metadata).toEqual({ type: 'json', value: { tool: 'wikipedia_search', status: 'success', items: [{ lang: 'en', pageId: 12, title: 'Example' }] } });
  expect(test.authorize).toHaveBeenCalledOnce();
  expect(test.execute.mock.invocationCallOrder[0]!).toBeGreaterThan(test.authorize.mock.invocationCallOrder[0]!);
});

it.each(['wikipedia_search', 'wikipedia_get_page', 'shell_execute'] as const)('reviews every %s invocation, even with identical arguments', async name => {
  await using test = toolExecutionFixture({ name, onError: 'fail' });
  await test.run();
  await test.run();
  expect(test.authorize).toHaveBeenCalledTimes(2);
  expect(test.execute).toHaveBeenCalledTimes(2);
  expect(test.authorize.mock.calls[0]![0].request).toEqual(test.execute.mock.calls[0]![0].request);
});

it('requires no external authority for the deterministic calculator', async () => {
  await using test = toolExecutionFixture({ name: 'calculator', onError: 'fail' });
  await test.run();
  expect(test.authorize).not.toHaveBeenCalled();
});

it('does not execute or write anything after permission denial, including continue mode', async () => {
  await using test = toolExecutionFixture({ name: 'shell_execute', onError: 'continue' });
  test.authorize.mockResolvedValue(false);
  await expect(test.run()).rejects.toThrow('denied');
  expect(test.execute).not.toHaveBeenCalled();
  expect(test.files.size).toBe(0);
});

it('freezes the reviewed arguments and isolates them from later document changes', async () => {
  await using test = toolExecutionFixture({ name: 'wikipedia_search', onError: 'fail' });
  test.authorize.mockImplementation(async ({ request }) => {
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.args)).toBe(true);
    if (test.input.request.name !== 'wikipedia_search') {
      throw new Error('Expected search');
    }
    test.input.request.args.query = 'changed after review';
    return true;
  });
  await test.run();
  expect(test.execute.mock.calls[0]![0].request.args).toEqual({ lang: 'en', query: 'workflow' });
});

it('rejects malformed arguments before permission or execution', async () => {
  await using test = toolExecutionFixture({ name: 'wikipedia_search', onError: 'continue' });
  if (test.input.request.name !== 'wikipedia_search') {
    throw new Error('Expected search');
  }
  test.input.request.args.lang = 'en.example.com';
  await expect(test.run()).rejects.toThrow();
  expect(test.authorize).not.toHaveBeenCalled();
  expect(test.execute).not.toHaveBeenCalled();
});

it('fails without publishing a logical error by default', async () => {
  await using test = toolExecutionFixture({ name: 'calculator', onError: 'fail' });
  test.execute.mockResolvedValue({ outcome: { status: 'error', code: 'execution_failed', message: 'Division by zero' }, metadata: {} });
  await expect(test.run()).rejects.toThrow('Division by zero');
  expect(test.store.getUsage().entries).toBe(0);
});

it('retains explicitly requested error outputs with ok=false and a reason', async () => {
  await using test = toolExecutionFixture({ name: 'shell_execute', onError: 'continue' });
  test.execute.mockResolvedValue({
    outcome: {
      status: 'error',
      code: 'execution_failed',
      message: `\
Exit Code: 7
failed command`,
    },
    metadata: { exitCode: 7 },
  });
  const outputs = await test.run();
  expect(outputs.ok).toEqual({ type: 'json', value: false });
  expect(outputs.metadata).toEqual({ type: 'json', value: { tool: 'shell_execute', status: 'error', code: 'execution_failed', exitCode: 7 } });
  expect(await readText({ value: outputs.text!, signal: undefined, maxBytes: 4096 })).toContain('failed command');
});

it('does not downgrade an infrastructure or cleanup failure to an error output', async () => {
  await using test = toolExecutionFixture({ name: 'shell_execute', onError: 'continue' });
  test.execute.mockRejectedValue(new Error('Worker cleanup failed'));
  await expect(test.run()).rejects.toThrow('cleanup');
  expect(test.files.size).toBe(0);
});

it('does not ask or execute after a preexisting stop', async () => {
  await using test = toolExecutionFixture({ name: 'wikipedia_search', onError: 'continue' });
  test.controller.abort(new Error('Stop'));
  await expect(test.run()).rejects.toThrow('Stop');
  expect(test.authorize).not.toHaveBeenCalled();
  expect(test.execute).not.toHaveBeenCalled();
});

it('ignores approval arriving after cancellation', async () => {
  await using test = toolExecutionFixture({ name: 'shell_execute', onError: 'continue' });
  test.authorize.mockImplementation(async () => {
    test.controller.abort(new Error('Stop'));
    return true;
  });
  await expect(test.run()).rejects.toThrow('Stop');
  expect(test.execute).not.toHaveBeenCalled();
});

it.each(['success', 'error'] as const)('awaits tool retirement and discards a late %s after cancellation', async status => {
  await using test = toolExecutionFixture({ name: 'shell_execute', onError: 'continue' });
  const completion = Promise.withResolvers<WorkflowToolExecution>();
  test.execute.mockReturnValue(completion.promise);
  const settled = vi.fn();
  const pending = test.run();
  const handled = pending.then(settled, settled);
  await vi.waitFor(() => expect(test.execute).toHaveBeenCalledOnce());
  test.controller.abort(new Error('Stop'));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(settled).not.toHaveBeenCalled();
  completion.resolve({ outcome: status === 'success' ? { status, content: 'late' } : { status, code: 'timeout', message: 'late timeout' }, metadata: {} });
  await expect(pending).rejects.toThrow('Stop');
  await handled;
  expect(test.files.size).toBe(0);
});

it.each(['write', 'snapshot'] as const)('cleans output when %s fails without repeating the tool', async operation => {
  await using test = toolExecutionFixture({ name: 'wikipedia_get_page', onError: 'continue' });
  test.failNext({ operation, error: new Error('Disk failed') });
  await expect(test.run()).rejects.toThrow('Disk failed');
  expect(test.files.size).toBe(0);
  expect(test.store.getUsage().entries).toBe(0);
  expect(test.execute).toHaveBeenCalledOnce();
});

it.each(['write', 'snapshot'] as const)('discards partially saved output stopped during %s', async operation => {
  await using test = toolExecutionFixture({ name: 'wikipedia_get_page', onError: 'continue' });
  const gate = test.pauseNext({ operation });
  const pending = test.run();
  const handled = pending.catch(() => undefined);
  await gate.entered;
  test.controller.abort(new Error('Stop'));
  gate.release();
  await expect(pending).rejects.toThrow('Stop');
  await handled;
  expect(test.files.size).toBe(0);
  expect(test.store.getUsage().entries).toBe(0);
});

it('spools multibyte text in bounded chunks without corrupting surrogate pairs', async () => {
  await using test = toolExecutionFixture({ name: 'wikipedia_get_page', onError: 'fail' });
  const content = '文'.repeat(8191) + '🌲'.repeat(9000);
  test.execute.mockResolvedValue({ outcome: { status: 'success', content }, metadata: {} });
  const outputs = await test.run();
  expect(await readText({ value: outputs.text!, signal: undefined, maxBytes: 131072 })).toBe(content);
  expect(test.calls.filter(call => call === 'write').length).toBeGreaterThan(1);
});

export const TEST_ONLY = {
};
