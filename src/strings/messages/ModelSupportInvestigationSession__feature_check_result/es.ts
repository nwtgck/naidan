export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "Primera generación",
    "continuity": "Continuidad de conversación",
    "tool-result": "Continuación tras resultado de herramienta",
    "reasoning": "Razonamiento",
    "multimodal": "Entrada de imagen",
    "template": "Plantilla de chat",
    "reference-load": "Carga de referencia",
    "input-strategy": "Método de entrada",
    "natural-generation": "Generación natural",
    "tool-probe": "Protocolo de herramienta forzado",
    "tool-parser": "Analizador de herramientas",
    "tool-template": "Plantilla de resultado de herramienta",
    "stage": "Etapa de investigación"
  };
  const outcomes = {
    "passed": "Ejecución correcta",
    "failed": "Falló",
    "observed": "Solo observado",
    "blocked": "Bloqueado",
    "not-run": "No ejecutado",
    "not-selected": "No seleccionado",
    "not-recorded": "No registrado",
    "unavailable": "No disponible"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
