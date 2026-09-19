export const TransformersJsManager__about_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Cerca de ${Math.ceil(seconds / 3600)} h restantes`;
  if (seconds >= 60) return `Cerca de ${Math.ceil(seconds / 60)} min restantes`;
  return `Cerca de ${Math.max(5, Math.ceil(seconds / 5) * 5)} s restantes`;
};
