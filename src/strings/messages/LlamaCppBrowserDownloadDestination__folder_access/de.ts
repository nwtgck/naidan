export const LlamaCppBrowserDownloadDestination__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: 'Lese- und Schreibzugriff',
  read: 'Schreibberechtigung erforderlich',
  prompt: 'Berechtigung erforderlich',
  missing: 'Ordner erneut auswählen',
  error: 'Ordner nicht verfügbar',
  unsupported: 'In diesem Browser oder Build nicht verfügbar',
})[access];
