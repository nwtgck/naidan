export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "Erste Generierung",
    "continuity": "Gesprächsfortsetzung",
    "tool-result": "Fortsetzung nach Werkzeugergebnis",
    "reasoning": "Reasoning",
    "multimodal": "Bildeingabe",
    "template": "Chatvorlage",
    "reference-load": "Referenz-Laden",
    "input-strategy": "Eingabeverfahren",
    "natural-generation": "Natürliche Generierung",
    "tool-probe": "Erzwungenes Werkzeugprotokoll",
    "tool-parser": "Werkzeugparser",
    "tool-template": "Vorlage für Werkzeugergebnis",
    "stage": "Untersuchungsschritt"
  };
  const outcomes = {
    "passed": "Ausführung erfolgreich",
    "failed": "Fehlgeschlagen",
    "observed": "Nur beobachtet",
    "blocked": "Blockiert",
    "not-run": "Nicht ausgeführt",
    "not-selected": "Nicht ausgewählt",
    "not-recorded": "Nicht aufgezeichnet",
    "unavailable": "Nicht verfügbar"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
