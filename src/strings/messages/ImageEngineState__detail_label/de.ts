export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "Modellversion";
  case "profile": return "Laufzeitprofil";
  case "source": return "Artefaktquelle";
  case "threads": return "Aufgelöste CPU-Threads";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
