export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: 'Tool result',
    definition: "Fixed definition",
    model_output: "Model response",
    file_input: "File",
    interactive_input: "Interactive input",
    unknown: "Unknown",
  };
  return "Value sources: " + sources.map(source => labels[source]).join(', ');
}
