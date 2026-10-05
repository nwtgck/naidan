export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Wasm-Speicherkapazität";
  case "file-cache": return "Lesecache für Modelldateien";
  case "model-tensors": return "Logische Größe der Modelltensoren";
  case "host-buffers": return "Verwaltete Host-Puffer";
  case "non-host-buffers": return "Verwaltete Nicht-Host-Puffer";
  case "last-cpu-buffers": return "Zuletzt gemeldete CPU-Laufzeitpuffer";
  case "last-non-cpu-buffers": return "Zuletzt gemeldete Nicht-CPU-Laufzeitpuffer";
  case "last-unknown-buffers": return "Zuletzt gemeldete Laufzeitpuffer (Gerät unbekannt)";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
