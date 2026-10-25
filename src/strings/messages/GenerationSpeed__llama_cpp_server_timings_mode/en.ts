export const GenerationSpeed__llama_cpp_server_timings_mode = ({ mode }: { mode: 'auto' | 'enabled' | 'disabled' }): string => {
  switch (mode) {
  case 'auto': return "Auto-detect";
  case 'enabled': return "Always request";
  case 'disabled': return "Do not request";
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unhandled timings mode: ${exhaustive}`);
  }
  }
};
