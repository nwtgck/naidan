export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "A investigação do escopo selecionado está em andamento. As evidências coletadas podem ser exportadas.";
  case 'completed': return "A investigação do escopo selecionado terminou. Confira os resultados e os limites das evidências.";
  case 'interrupted': return "A investigação foi interrompida antes da conclusão. As evidências coletadas estão disponíveis.";
  case 'unknown': return "A conclusão da investigação não foi registrada.";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
