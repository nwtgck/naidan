export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "Model version";
  case "profile": return "Runtime profile";
  case "source": return "Artifact source";
  case "threads": return "Resolved CPU threads";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
