export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "Selected-scope investigation is running. Collected evidence can be exported.";
  case 'completed': return "Selected-scope investigation finished. See results and evidence limitations below.";
  case 'interrupted': return "Investigation stopped before completion. Collected evidence is available.";
  case 'unknown': return "Execution completion has not been recorded.";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
