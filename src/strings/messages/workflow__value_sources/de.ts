export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: 'Werkzeugergebnis',
    definition: "Feste Definition",
    model_output: "Modellantwort",
    file_input: "Datei",
    interactive_input: "Interaktive Eingabe",
    unknown: "Unbekannt",
  };
  return "Wertquellen: " + sources.map(source => labels[source]).join(', ');
}
