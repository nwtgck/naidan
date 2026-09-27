export const ImageHostModelDirectories__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: 'Acesso de leitura e gravação',
  read: 'Permissão de gravação necessária',
  prompt: 'Permissão necessária',
  missing: 'Selecione a pasta novamente',
  error: 'Pasta indisponível',
  unsupported: 'Indisponível neste navegador ou versão',
})[access];
