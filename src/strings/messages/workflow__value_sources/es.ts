export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: 'Resultado de herramienta',
    definition: "Definición fija",
    model_output: "Respuesta del modelo",
    file_input: "Archivo",
    interactive_input: "Entrada interactiva",
    unknown: "Desconocido",
  };
  return "Origen de los valores: " + sources.map(source => labels[source]).join(', ');
}
