import { idToRaw, toWorkflowId, toWorkflowRunId, type WorkflowId, type WorkflowRunId } from '@/01-models/ids';

export type WorkflowLocation =
  | { type: 'editor', id: WorkflowId | undefined }
  | { type: 'history', id: WorkflowRunId | undefined }
  | { type: 'other' };

export function workflowLocation({ path }: { path: string }): WorkflowLocation {
  const normalized = path.replace(/\/+$/, '');
  if (normalized === '/workflows') {
    return { type: 'editor', id: undefined };
  }
  if (normalized === '/workflows/runs') {
    return { type: 'history', id: undefined };
  }
  const run = /^\/workflows\/runs\/([A-Za-z0-9_-]{1,64})$/.exec(normalized);
  if (run?.[1]) {
    return { type: 'history', id: toWorkflowRunId({ raw: run[1] }) };
  }
  const document = /^\/workflows\/([A-Za-z0-9_-]{1,64})$/.exec(normalized);
  return document?.[1] ? { type: 'editor', id: toWorkflowId({ raw: document[1] }) } : { type: 'other' };
}

export function workflowDocumentPath({ id }: { id: WorkflowId }): string {
  return `/workflows/${encodeURIComponent(idToRaw({ id }))}`;
}

export function workflowRunPath({ id }: { id: WorkflowRunId }): string {
  return `/workflows/runs/${encodeURIComponent(idToRaw({ id }))}`;
}

export const TEST_ONLY = {
};
