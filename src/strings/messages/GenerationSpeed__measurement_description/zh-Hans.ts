export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "根据Ollama报告的输出数量和生成时间计算。不包含工具执行和输入处理时间。",
  llama_cpp_predicted: "llama.cpp server的生成计时数据。不包含工具执行和输入处理时间。",
  worker_sample_interval: "根据Worker内的词元采样间隔计算，不含首个词元和生成结束词元。包含运行和传输开销，并非仅原生计算速度。",
  client_request: "根据报告的词元用量和请求时间计算的近似有效速度。包含等待、输入处理、网络和客户端开销，并非解码速度。",
  received_text: "按Unicode码点数计算的近似文本接收速度，包含可获取的思考内容和流式工具参数。包含网络和客户端延迟，并非词元生成速度。",
}[measurement]);
