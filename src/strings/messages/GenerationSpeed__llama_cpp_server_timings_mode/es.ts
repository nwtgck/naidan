export const GenerationSpeed__llama_cpp_server_timings_mode = ({ mode }: { mode: 'auto' | 'enabled' | 'disabled' }): string => {
  switch (mode) {
  case 'auto': return "Detectar automáticamente";
  case 'enabled': return "Solicitar siempre";
  case 'disabled': return "No solicitar";
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unhandled timings mode: ${exhaustive}`);
  }
  }
};
