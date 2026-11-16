import type { WorkflowGuideMessages } from '../../messages/types';

// Plain article data: the app parser checks this example in the guide test.
// Runtime, model preparation and app state never enter the static Docs page.
export function createWorkflowGuideExample({ messages: s }: { messages: WorkflowGuideMessages }) {
  const generation = ({ id, name, instruction, source, output }: { id: string; name: string; instruction: string; source: string; output: string }) => ({
    id,
    name,
    type: 'text_generation',
    target: { type: 'model', endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'qwen3:8b' },
    conversation: { type: 'conversation', messages: [] },
    appendMessages: [{
      role: 'user',
      parts: [
        { type: 'text', text: instruction },
        { type: 'value', value: { type: 'step_output', stepId: source, output } },
      ],
    }],
    toolConfigs: [],
  });
  return {
    name: s.example_name,
    steps: [
      { id: 'meeting-notes', name: s.input_name, type: 'request_input', prompt: { type: 'literal', value: s.input_prompt }, responseType: 'text' },
      generation({ id: 'three-points', name: s.summary_name, instruction: s.summary_instruction, source: 'meeting-notes', output: 'value' }),
      generation({ id: 'team-update', name: s.share_name, instruction: s.share_instruction, source: 'three-points', output: 'text' }),
    ],
  };
}
