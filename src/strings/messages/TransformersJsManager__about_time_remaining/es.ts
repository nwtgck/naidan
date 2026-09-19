export const TransformersJsManager__about_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Quedan aproximadamente ${Math.ceil(seconds / 3600)} h`;
  if (seconds >= 60) return `Quedan aproximadamente ${Math.ceil(seconds / 60)} min`;
  return `Quedan aproximadamente ${Math.max(5, Math.ceil(seconds / 5) * 5)} s`;
};
