export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"Preparing","loading":"Loading the local model","running":"Running fixed requests","collecting":"Collecting native records","sealing":"Preparing evidence files","cleanup":"Waiting for Worker cleanup","seal-release":"Waiting for recording ownership to be released","finished":"Collection ended"};
  return `${labels[phase]} · ${settled}/${total} requests settled${active === undefined ? "" : ` · ${active}`}`;
};
