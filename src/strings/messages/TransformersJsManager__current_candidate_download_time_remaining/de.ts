export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Download des aktuellen Kandidaten: noch etwa ${Math.ceil(seconds / 3600)} Std.`;
  if (seconds >= 60) return `Download des aktuellen Kandidaten: noch etwa ${Math.ceil(seconds / 60)} Min.`;
  return `Download des aktuellen Kandidaten: noch etwa ${Math.max(5, Math.ceil(seconds / 5) * 5)} Sek.`;
};
