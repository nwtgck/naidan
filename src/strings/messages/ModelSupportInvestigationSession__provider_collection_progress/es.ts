export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"Preparando","loading":"Cargando el modelo local","running":"Ejecutando solicitudes fijas","collecting":"Recopilando registros nativos","sealing":"Preparando archivos de evidencia","cleanup":"Esperando la limpieza del Worker","seal-release":"Esperando la liberación de los registros","finished":"Recopilación finalizada"};
  return `${labels[phase]} · ${settled}/${total} solicitudes finalizadas${active === undefined ? "" : ` · ${active}`}`;
};
