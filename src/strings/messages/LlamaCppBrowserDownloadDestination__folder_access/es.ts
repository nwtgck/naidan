export const LlamaCppBrowserDownloadDestination__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: 'Acceso de lectura y escritura',
  read: 'Se necesita permiso de escritura',
  prompt: 'Se necesita permiso',
  missing: 'Selecciona la carpeta de nuevo',
  error: 'Carpeta no disponible',
  unsupported: 'No disponible en este navegador o compilación',
})[access];
