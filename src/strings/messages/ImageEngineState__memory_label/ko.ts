export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Wasm 메모리 용량";
  case "file-cache": return "모델 파일 읽기 캐시";
  case "model-tensors": return "모델 텐서의 논리적 크기";
  case "host-buffers": return "관리 중인 호스트 버퍼";
  case "non-host-buffers": return "관리 중인 비호스트 버퍼";
  case "last-cpu-buffers": return "마지막으로 보고된 CPU 런타임 버퍼";
  case "last-non-cpu-buffers": return "마지막으로 보고된 비CPU 런타임 버퍼";
  case "last-unknown-buffers": return "마지막으로 보고된 런타임 버퍼(장치 알 수 없음)";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
