export const ImageGenerationProgress__steps_completed = ({ current, total }: { current: number; total: number }): string => `${current} / ${total} ${total === 1 ? 'step' : 'steps'} completed`;
