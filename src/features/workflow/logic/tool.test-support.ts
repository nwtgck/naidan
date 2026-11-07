import type { WorkflowStep } from '@/01-models/workflow';
import { toWorkflowStepId, toVolumeId } from '@/01-models/ids';
import { parseWorkflowJson } from '@/00-storage/service/workflow-json';
import type { WorkflowToolRequest } from './tool-input';

export function toolRequest({ name }: { name: WorkflowToolRequest['name'] }): WorkflowToolRequest {
  switch (name) {
  case 'calculator': return { name, args: { expression: '1 + 1' } };
  case 'wikipedia_search': return { name, args: { lang: 'en', query: 'workflow' } };
  case 'wikipedia_get_page': return { name, args: { lang: 'en', pageId: 12 } };
  case 'shell_execute': return { name, volumeId: toVolumeId({ raw: 'folder' }), access: 'read-only', args: { shell_script: 'pwd', stdout_limit: 16384, stderr_limit: 8192, timeout_ms: 8000 } };
  default: {
    const exhaustive: never = name;
    throw new Error(String(exhaustive));
  }
  }
}

export function toolStep({ id, request, onError }: { id: string, request: WorkflowToolRequest, onError: 'fail' | 'continue' }): Extract<WorkflowStep, { type: 'tool_call' }> {
  return {
    id: toWorkflowStepId({ raw: id }),
    name: id,
    type: 'tool_call',
    onError,
    tool: (() => {
      switch (request.name) {
      case 'shell_execute': return { name: request.name, volumeId: request.volumeId, access: request.access };
      case 'calculator': case 'wikipedia_search': case 'wikipedia_get_page': return { name: request.name };
      default: {
        const exhaustive: never = request;
        throw new Error(String(exhaustive));
      }
      }
    })(),
    arguments: { type: 'literal', value: parseWorkflowJson({ text: JSON.stringify(request.args) }) },
  };
}

export const TEST_ONLY = {
};
