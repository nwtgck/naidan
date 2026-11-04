import { lazyStrings, ensureStrings } from '@/strings';
import type { WorkflowStep } from '@/01-models/workflow';

export function workflowStepLabel({ type }: { type: WorkflowStep['type'] }): string | undefined {
  switch (type) {
  case 'value': return lazyStrings.workflow__value();
  case 'model_selection': return lazyStrings.workflow__select_models();
  case 'parse_json': return lazyStrings.workflow__parse_json();
  case 'text_generation': return lazyStrings.workflow__text_generation();
  case 'request_input': return lazyStrings.workflow__request_input();
  case 'repeat': return lazyStrings.workflow__repeat();
  case 'for_each': return lazyStrings.workflow__for_each();
  case 'if': return lazyStrings.workflow__if();
  case 'read_file': return lazyStrings.workflow__read_file();
  case 'write_file': return lazyStrings.workflow__write_file();
  default: {
    const exhaustive: never = type;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
}

export async function ensureWorkflowStepLabel({ type }: { type: WorkflowStep['type'] }): Promise<string> {
  switch (type) {
  case 'value': return ensureStrings.workflow__value();
  case 'model_selection': return ensureStrings.workflow__select_models();
  case 'parse_json': return ensureStrings.workflow__parse_json();
  case 'text_generation': return ensureStrings.workflow__text_generation();
  case 'request_input': return ensureStrings.workflow__request_input();
  case 'repeat': return ensureStrings.workflow__repeat();
  case 'for_each': return ensureStrings.workflow__for_each();
  case 'if': return ensureStrings.workflow__if();
  case 'read_file': return ensureStrings.workflow__read_file();
  case 'write_file': return ensureStrings.workflow__write_file();
  default: {
    const exhaustive: never = type;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
}

export function workflowInputText({ event }: { event: Event }): string {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return target.value;
  }
  throw new Error('Expected a form input.');
}

export const workflowStepTypes: WorkflowStep['type'][] = ['value', 'model_selection', 'text_generation', 'parse_json', 'request_input', 'repeat', 'for_each', 'if', 'read_file', 'write_file'];
export const TEST_ONLY = {
};
