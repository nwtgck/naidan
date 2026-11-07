import type { WorkflowToolExecutor, WorkflowToolExecution } from '@/features/workflow/logic/tool-execution';

/** Reuse tool implementations without inheriting a ChatId, settings mounts,
 * chat approvals, or the chat-specific long-page/sysfs persistence policy. */
export const executeWorkflowBuiltinTool: WorkflowToolExecutor = async ({ request, signal }) => {
  signal.throwIfAborted();
  switch (request.name) {
  case 'calculator': {
    const { CalculatorTool } = await import('@/features/tools/calculator');
    signal.throwIfAborted();
    return { outcome: await new CalculatorTool().execute({ args: request.args, signal }), metadata: {} };
  }
  case 'wikipedia_search': case 'wikipedia_get_page': {
    const client = await import('@/features/tools/wikipedia/client');
    signal.throwIfAborted();
    try {
      switch (request.name) {
      case 'wikipedia_search': {
        const { renderWikipediaSearchMarkdown } = await import('@/features/tools/wikipedia/render');
        signal.throwIfAborted();
        const result = await client.searchWikipedia({ ...request.args, contextLanguage: undefined, signal, requestResponseImpl: undefined });
        signal.throwIfAborted();
        return { outcome: { status: 'success', content: renderWikipediaSearchMarkdown({ groups: result.groups }) }, metadata: { items: result.groups.flatMap(group => group.items.map(item => ({ lang: group.lang, pageId: item.pageId, title: item.title }))) } };
      }
      case 'wikipedia_get_page': {
        const page = await client.getWikipediaPageContent({ ...request.args, signal, requestResponseImpl: undefined });
        signal.throwIfAborted();
        return { outcome: { status: 'success', content: page.content }, metadata: { lang: page.lang, pageId: page.pageId, title: page.title } };
      }
      default: {
        const exhaustive: never = request;
        throw new Error(String(exhaustive));
      }
      }
    } catch (error) {
      signal.throwIfAborted();
      return { outcome: { status: 'error', code: 'execution_failed', message: error instanceof Error ? error.message : String(error) }, metadata: {} };
    }
  }
  case 'shell_execute': {
    const { openWorkflowShell } = await import('./wesh');
    signal.throwIfAborted();
    const shell = await openWorkflowShell({ volumeId: request.volumeId, access: request.access, signal });
    try {
      const result: WorkflowToolExecution = await shell.execute({ args: request.args, signal });
      signal.throwIfAborted();
      return result;
    } finally {
      // A close failure remains a real failure, even with onError=continue.
      await shell.close();
    }
  }
  default: {
    const exhaustive: never = request;
    throw new Error(String(exhaustive));
  }
  }
};

export const TEST_ONLY = {
};
