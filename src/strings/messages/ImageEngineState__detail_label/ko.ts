export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "모델 버전";
  case "profile": return "런타임 프로필";
  case "source": return "아티팩트 소스";
  case "threads": return "실제 CPU 스레드 수";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
