export const ImageEngineState__detail_label = ({ detail }: { detail: "model" | "profile" | "source" | "threads" }): string => {
  switch (detail) {
  case "model": return "Versão do modelo";
  case "profile": return "Perfil de execução";
  case "source": return "Origem do artefato";
  case "threads": return "Threads de CPU efetivas";
  default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
  }
};
