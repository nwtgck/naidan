export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: "Resultado da ferramenta",
    definition: "Definição fixa",
    model_output: "Resposta do modelo",
    file_input: "Arquivo",
    interactive_input: "Entrada interativa",
    unknown: "Desconhecida",
  };
  return "Origem dos valores: " + sources.map(source => labels[source]).join(', ');
}
