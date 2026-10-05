export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Wasm memory capacity";
  case "file-cache": return "Model file read cache";
  case "model-tensors": return "Model tensor logical size";
  case "host-buffers": return "Manager-held host buffers";
  case "non-host-buffers": return "Manager-held non-host buffers";
  case "last-cpu-buffers": return "Last reported CPU runtime buffers";
  case "last-non-cpu-buffers": return "Last reported non-CPU runtime buffers";
  case "last-unknown-buffers": return "Last reported runtime buffers (device unknown)";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
