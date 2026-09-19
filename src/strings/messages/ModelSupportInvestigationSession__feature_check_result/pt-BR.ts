export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "Primeira geração",
    "continuity": "Continuidade da conversa",
    "tool-result": "Continuação após resultado da ferramenta",
    "reasoning": "Raciocínio",
    "multimodal": "Entrada de imagem",
    "template": "Modelo de chat",
    "reference-load": "Carregamento de referência",
    "input-strategy": "Método de entrada",
    "natural-generation": "Geração natural",
    "tool-probe": "Protocolo de ferramenta forçado",
    "tool-parser": "Analisador de ferramentas",
    "tool-template": "Modelo de resultado de ferramenta",
    "stage": "Etapa da investigação"
  };
  const outcomes = {
    "passed": "Execução bem-sucedida",
    "failed": "Falhou",
    "observed": "Apenas observado",
    "blocked": "Bloqueado",
    "not-run": "Não executado",
    "not-selected": "Não selecionado",
    "not-recorded": "Não registrado",
    "unavailable": "Indisponível"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
