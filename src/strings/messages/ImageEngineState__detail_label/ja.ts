export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "モデルのバージョン";
  case "profile": return "実行プロファイル";
  case "source": return "アーティファクトのソース";
  case "threads": return "CPUスレッド数（実効値）";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
