export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "模型版本";
  case "profile": return "运行配置";
  case "source": return "构建产物来源";
  case "threads": return "实际 CPU 线程数";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
