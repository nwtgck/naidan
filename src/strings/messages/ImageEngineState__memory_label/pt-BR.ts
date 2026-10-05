export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Capacidade de memória Wasm";
  case "file-cache": return "Cache de leitura dos arquivos do modelo";
  case "model-tensors": return "Tamanho lógico dos tensores do modelo";
  case "host-buffers": return "Buffers gerenciados no host";
  case "non-host-buffers": return "Buffers gerenciados fora do host";
  case "last-cpu-buffers": return "Últimos buffers de execução de CPU informados";
  case "last-non-cpu-buffers": return "Últimos buffers de execução não CPU informados";
  case "last-unknown-buffers": return "Últimos buffers de execução informados (dispositivo desconhecido)";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
