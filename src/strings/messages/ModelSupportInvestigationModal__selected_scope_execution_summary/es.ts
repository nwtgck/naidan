export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "La investigación del alcance seleccionado está en curso. Se pueden exportar las pruebas recopiladas.";
  case 'completed': return "La investigación del alcance seleccionado terminó. Consulta los resultados y los límites de las pruebas.";
  case 'interrupted': return "La investigación se detuvo antes de finalizar. Las pruebas recopiladas están disponibles.";
  case 'unknown': return "No se ha registrado la finalización de la investigación.";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
