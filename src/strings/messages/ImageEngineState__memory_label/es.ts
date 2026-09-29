export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Capacidad de memoria Wasm";
  case "file-cache": return "Caché de lectura de archivos del modelo";
  case "model-tensors": return "Tamaño lógico de los tensores del modelo";
  case "host-buffers": return "Búferes gestionados en el host";
  case "non-host-buffers": return "Búferes gestionados fuera del host";
  case "last-cpu-buffers": return "Últimos búferes de ejecución de CPU informados";
  case "last-non-cpu-buffers": return "Últimos búferes de ejecución no CPU informados";
  case "last-unknown-buffers": return "Últimos búferes de ejecución informados (dispositivo desconocido)";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
