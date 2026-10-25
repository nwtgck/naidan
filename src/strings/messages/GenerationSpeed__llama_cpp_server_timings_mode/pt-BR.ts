export const GenerationSpeed__llama_cpp_server_timings_mode = ({ mode }: { mode: 'auto' | 'enabled' | 'disabled' }): string => {
  switch (mode) {
  case 'auto': return "Detectar automaticamente";
  case 'enabled': return "Sempre solicitar";
  case 'disabled': return "Não solicitar";
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unhandled timings mode: ${exhaustive}`);
  }
  }
};
