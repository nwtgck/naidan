export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Descarga del candidato actual: quedan unos ${Math.ceil(seconds / 3600)} h`;
  if (seconds >= 60) return `Descarga del candidato actual: quedan unos ${Math.ceil(seconds / 60)} min`;
  return `Descarga del candidato actual: quedan unos ${Math.max(5, Math.ceil(seconds / 5) * 5)} s`;
};
