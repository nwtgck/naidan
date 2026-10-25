export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "Cantidad de salida y tiempo de generación informados por Ollama. Excluye herramientas y procesamiento de entrada.",
  llama_cpp_predicted: "Tiempos de generación de llama.cpp server. Excluye herramientas y procesamiento de entrada.",
  worker_sample_interval: "Intervalos de muestreo de tokens en el Worker, sin el primer token ni los de fin. Incluye ejecución y entrega, no solo cálculo nativo.",
  client_request: "Velocidad efectiva aproximada según el uso informado y la duración de la solicitud. Incluye espera, entrada, red y cliente; no es velocidad de decodificación.",
  received_text: "Velocidad de recepción aproximada en puntos de código Unicode, incluido razonamiento y argumentos de herramientas disponibles. Incluye retrasos de red y cliente; no es velocidad de tokens.",
}[measurement]);
