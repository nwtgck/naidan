export const GenerationSpeed__llama_cpp_server_timings_mode = ({ mode }: { mode: 'auto' | 'enabled' | 'disabled' }): string => {
  switch (mode) {
  case 'auto': return "自動検出";
  case 'enabled': return "常に要求";
  case 'disabled': return "要求しない";
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unhandled timings mode: ${exhaustive}`);
  }
  }
};
