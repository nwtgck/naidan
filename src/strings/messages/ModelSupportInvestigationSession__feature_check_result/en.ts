export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "First-turn generation",
    "continuity": "Conversation continuity",
    "tool-result": "Tool-result continuation",
    "reasoning": "Reasoning",
    "multimodal": "Image input",
    "template": "Chat template",
    "reference-load": "Reference load",
    "input-strategy": "Input strategy",
    "natural-generation": "Natural generation",
    "tool-probe": "Forced tool protocol",
    "tool-parser": "Tool parser",
    "tool-template": "Tool-result template",
    "stage": "Investigation stage"
  };
  const outcomes = {
    "passed": "Execution succeeded",
    "failed": "Failed",
    "observed": "Observed only",
    "blocked": "Blocked",
    "not-run": "Not run",
    "not-selected": "Not selected",
    "not-recorded": "Not recorded",
    "unavailable": "Unavailable"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
