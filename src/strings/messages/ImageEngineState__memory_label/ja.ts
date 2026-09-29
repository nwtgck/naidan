export const ImageEngineState__memory_label = ({ measure }: { measure: "wasm" | "file-cache" | "model-tensors" | "host-buffers" | "non-host-buffers" | "last-cpu-buffers" | "last-non-cpu-buffers" | "last-unknown-buffers" }): string => {
  switch (measure) {
  case "wasm": return "Wasmメモリの確保容量";
  case "file-cache": return "モデルファイルの読取キャッシュ";
  case "model-tensors": return "モデルテンソルの論理サイズ";
  case "host-buffers": return "管理中のホスト側バッファ";
  case "non-host-buffers": return "管理中の非ホスト側バッファ";
  case "last-cpu-buffers": return "直近報告のCPU実行用バッファ";
  case "last-non-cpu-buffers": return "直近報告の非CPU実行用バッファ";
  case "last-unknown-buffers": return "直近報告の実行用バッファ（デバイス不明）";
  default: { const exhaustive: never = measure; throw new Error(String(exhaustive)); }
  }
};
