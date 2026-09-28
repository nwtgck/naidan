export const ImageEngineState__busy_during_generation = ({ phase }: { phase: string }): string => `Generation is running (${phase}). Live measurements cannot be refreshed until the engine is idle.`;
