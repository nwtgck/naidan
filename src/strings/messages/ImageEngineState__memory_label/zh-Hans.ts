export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Wasm 内存容量";
  case "file-cache": return "模型文件读取缓存";
  case "model-tensors": return "模型张量的逻辑大小";
  case "host-buffers": return "管理中的主机缓冲区";
  case "non-host-buffers": return "管理中的非主机缓冲区";
  case "last-cpu-buffers": return "最近报告的 CPU 运行缓冲区";
  case "last-non-cpu-buffers": return "最近报告的非 CPU 运行缓冲区";
  case "last-unknown-buffers": return "最近报告的运行缓冲区（设备未知）";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
