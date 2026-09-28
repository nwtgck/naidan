export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "Versión del modelo";
  case "profile": return "Perfil de ejecución";
  case "source": return "Origen del artefacto";
  case "threads": return "Hilos de CPU efectivos";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
