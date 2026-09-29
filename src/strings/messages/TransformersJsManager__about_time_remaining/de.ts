export const TransformersJsManager__about_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Noch etwa ${Math.ceil(seconds / 3600)} Std.`;
  if (seconds >= 60) return `Noch etwa ${Math.ceil(seconds / 60)} Min.`;
  return `Noch etwa ${Math.max(5, Math.ceil(seconds / 5) * 5)} Sek.`;
};
