import { beforeEach, it, expect, vi } from 'vitest';
import { executeWorkflowBuiltinTool } from './tools';
import { toolRequest } from '@/features/workflow/logic/tool.test-support';

const mocks = vi.hoisted(() => ({ search: vi.fn(), page: vi.fn(), legacyPage: vi.fn(), openShell: vi.fn(), executeShell: vi.fn(), closeShell: vi.fn() }));
vi.mock('@/features/tools/wikipedia/client', () => ({ searchWikipedia: mocks.search, getWikipediaPageContent: mocks.page, getWikipediaPage: mocks.legacyPage }));
vi.mock('./wesh', () => ({ openWorkflowShell: mocks.openShell }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.openShell.mockResolvedValue({ execute: mocks.executeShell, close: mocks.closeShell });
  mocks.closeShell.mockResolvedValue(undefined);
  mocks.executeShell.mockResolvedValue({ outcome: { status: 'success', content: 'Exit Code: 0' }, metadata: { exitCode: 0 } });
});

it('returns exact rational output from the existing calculator implementation', async () => {
  const result = await executeWorkflowBuiltinTool({ request: { name: 'calculator', args: { expression: '1/3', output: { format: 'rational' } } }, signal: new AbortController().signal });
  expect(result.outcome).toEqual({ status: 'success', content: '1/3' });
});

it('preserves a calculator error rather than inventing a result', async () => {
  const result = await executeWorkflowBuiltinTool({ request: { name: 'calculator', args: { expression: '1/0' } }, signal: new AbortController().signal });
  expect(result.outcome.status).toBe('error');
});

it('uses the shared search client and provides typed items for later loops', async () => {
  mocks.search.mockResolvedValue({
    groups: [{
      lang: 'en',
      items: [{
        pageId: 12,
        title: `\
One
Two`,
      }],
    }],
  });
  const signal = new AbortController().signal;
  const result = await executeWorkflowBuiltinTool({ request: toolRequest({ name: 'wikipedia_search' }), signal });
  expect(mocks.search).toHaveBeenCalledExactlyOnceWith({ lang: 'en', query: 'workflow', contextLanguage: undefined, requestResponseImpl: undefined, signal });
  expect(result.outcome).toEqual({ status: 'success', content: 'lang\tpageId\ttitle\nen\t12\tOne Two' });
  expect(result.metadata).toEqual({
    items: [{
      lang: 'en',
      pageId: 12,
      title: `\
One
Two`,
    }],
  });
});

it('returns a long page in full without the chat/sysfs persistence wrapper', async () => {
  const content = 'long page\n'.repeat(200);
  mocks.page.mockResolvedValue({ lang: 'en', pageId: 12, title: 'Example', content });
  const result = await executeWorkflowBuiltinTool({ request: toolRequest({ name: 'wikipedia_get_page' }), signal: new AbortController().signal });
  expect(result).toEqual({ outcome: { status: 'success', content }, metadata: { lang: 'en', pageId: 12, title: 'Example' } });
  expect(mocks.legacyPage).not.toHaveBeenCalled();
});

it('surfaces a network failure as a tool error without retrying the adapter', async () => {
  mocks.search.mockRejectedValue(new Error('Request rejected'));
  const result = await executeWorkflowBuiltinTool({ request: toolRequest({ name: 'wikipedia_search' }), signal: new AbortController().signal });
  expect(result.outcome).toEqual({ status: 'error', code: 'execution_failed', message: 'Request rejected' });
  expect(mocks.search).toHaveBeenCalledOnce();
});

it('does not swallow a cancellation as a continuable Wikipedia failure', async () => {
  const controller = new AbortController();
  mocks.page.mockImplementation(async () => {
    controller.abort(new Error('Stop'));
    throw new Error('Aborted fetch');
  });
  await expect(executeWorkflowBuiltinTool({ request: toolRequest({ name: 'wikipedia_get_page' }), signal: controller.signal })).rejects.toThrow('Stop');
});

it('does not start any backend after cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Stop'));
  await expect(executeWorkflowBuiltinTool({ request: toolRequest({ name: 'shell_execute' }), signal: controller.signal })).rejects.toThrow('Stop');
  expect(mocks.openShell).not.toHaveBeenCalled();
});

it.each([false, true])('closes an invocation-owned shell on success or failure: %s', async fails => {
  if (fails) {
    mocks.executeShell.mockRejectedValue(new Error('Worker failed'));
  }
  const pending = executeWorkflowBuiltinTool({ request: toolRequest({ name: 'shell_execute' }), signal: new AbortController().signal });
  if (fails) {
    await expect(pending).rejects.toThrow('Worker failed');
  } else {
    await expect(pending).resolves.toMatchObject({ outcome: { status: 'success' } });
  }
  expect(mocks.closeShell).toHaveBeenCalledOnce();
});

it('waits for shell cleanup before returning and propagates its failure', async () => {
  const cleanup = Promise.withResolvers<void>();
  mocks.closeShell.mockReturnValue(cleanup.promise);
  const pending = executeWorkflowBuiltinTool({ request: toolRequest({ name: 'shell_execute' }), signal: new AbortController().signal });
  const settled = vi.fn();
  const handled = pending.then(settled, settled);
  await vi.waitFor(() => expect(mocks.closeShell).toHaveBeenCalledOnce());
  expect(settled).not.toHaveBeenCalled();
  cleanup.reject(new Error('Cleanup failed'));
  await expect(pending).rejects.toThrow('Cleanup failed');
  await handled;
});

export const TEST_ONLY = {
};
