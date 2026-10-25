export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "Quantidade de saída e tempo de geração informados pelo Ollama. Exclui ferramentas e processamento da entrada.",
  llama_cpp_predicted: "Tempos de geração do llama.cpp server. Exclui ferramentas e processamento da entrada.",
  worker_sample_interval: "Intervalos de amostragem de tokens no Worker, sem o primeiro token e os de fim. Inclui execução e entrega, não apenas computação nativa.",
  client_request: "Taxa efetiva aproximada com base no uso informado e na duração da solicitação. Inclui espera, entrada, rede e cliente; não é velocidade de decodificação.",
  received_text: "Taxa de recepção aproximada em pontos de código Unicode, incluindo raciocínio e argumentos de ferramentas disponíveis. Inclui atrasos de rede e cliente; não é velocidade de tokens.",
}[measurement]);
