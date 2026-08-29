export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `Procedencia de la plantilla de herramientas: ${suffixTokenCount ?? 0} ${(suffixTokenCount ?? 0) === 1 ? 'token de sufijo' : 'tokens de sufijo'} de la llamada de herramienta del assistant ${(suffixTokenCount ?? 0) === 1 ? 'se aisló' : 'se aislaron'} de la salida resuelta del tokenizador.`;
  case 'difference':
    return `Procedencia de la plantilla de herramientas: las secuencias de tokens renderizadas difieren por primera vez en ${firstMismatchIndex ?? 'el límite de longitud'}; no se infirió ningún sufijo.`;
  case 'unavailable':
    return `Procedencia de la plantilla de herramientas no disponible: ${reason ?? 'no se observaron los casos de plantilla necesarios'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
