export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"Vorbereitung","loading":"Lokales Modell laden","running":"Feste Anfragen ausführen","collecting":"Native Aufzeichnungen sammeln","sealing":"Evidenzdateien vorbereiten","cleanup":"Auf Worker-Bereinigung warten","seal-release":"Auf Freigabe der Aufzeichnungen warten","finished":"Erfassung beendet"};
  return `${labels[phase]} · ${settled}/${total} Anfragen beendet${active === undefined ? "" : ` · ${active}`}`;
};
