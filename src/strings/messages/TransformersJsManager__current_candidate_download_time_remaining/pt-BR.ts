export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Download do candidato atual: cerca de ${Math.ceil(seconds / 3600)} h restantes`;
  if (seconds >= 60) return `Download do candidato atual: cerca de ${Math.ceil(seconds / 60)} min restantes`;
  return `Download do candidato atual: cerca de ${Math.max(5, Math.ceil(seconds / 5) * 5)} s restantes`;
};
