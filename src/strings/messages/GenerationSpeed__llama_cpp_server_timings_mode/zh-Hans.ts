export const GenerationSpeed__llama_cpp_server_timings_mode = ({ mode }: { mode: 'auto' | 'enabled' | 'disabled' }): string => {
  switch (mode) {
  case 'auto': return "自动检测";
  case 'enabled': return "始终请求";
  case 'disabled': return "不请求";
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unhandled timings mode: ${exhaustive}`);
  }
  }
};
