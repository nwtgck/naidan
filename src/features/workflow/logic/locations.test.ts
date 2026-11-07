import { describe, expect, it } from 'vitest';
import { workflowLocation, workflowDocumentPath, workflowRunPath } from './locations';
import { toWorkflowId, toWorkflowRunId } from '@/01-models/ids';

describe('Workflow locations', () => {
  it('distinguishes documents, history and runs without reserving generated nanoid prefixes', () => {
    expect(workflowLocation({ path: '/workflows' })).toEqual({ type: 'editor', id: undefined });
    expect(workflowLocation({ path: '/workflows/test-id/' })).toEqual({ type: 'editor', id: 'test-id' });
    expect(workflowLocation({ path: '/workflows/runs' })).toEqual({ type: 'history', id: undefined });
    expect(workflowLocation({ path: '/workflows/runs/run-id/' })).toEqual({ type: 'history', id: 'run-id' });
    expect(workflowLocation({ path: '/workflows/runs-abc' })).toEqual({ type: 'editor', id: 'runs-abc' });
    expect(workflowDocumentPath({ id: toWorkflowId({ raw: 'doc' }) })).toBe('/workflows/doc');
    expect(workflowRunPath({ id: toWorkflowRunId({ raw: 'run' }) })).toBe('/workflows/runs/run');
  });

  it('does not treat unrelated routes, encoded slashes or nested paths as an identity', () => {
    for (const path of ['/workflowship/a', '/workflows/../../settings', '/workflows/a/b', '/workflows/%2F', '/workflows/runs/']) {
      const value = workflowLocation({ path });
      if (path === '/workflows/runs/') {
        expect(value).toEqual({ type: 'history', id: undefined });
      } else {
        expect(value).toEqual({ type: 'other' });
      }
    }
  });
});
