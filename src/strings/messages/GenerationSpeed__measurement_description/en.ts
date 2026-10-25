export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "Ollama-reported output count and generation time. Tool execution and input processing are excluded.",
  llama_cpp_predicted: "llama.cpp server generation timings. Tool execution and input processing are excluded.",
  worker_sample_interval: "Worker token-sample intervals, excluding the first token and end-of-generation tokens. Includes runtime and delivery overhead; not just native compute time.",
  client_request: "Approximate end-to-end token rate from reported usage and request time. Includes waiting, input processing, network and client overhead; not decode speed.",
  received_text: "Approximate received-text rate in Unicode code points, including reasoning and streamed tool arguments when available. Includes network and client delays; not token speed.",
}[measurement]);
