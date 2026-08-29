export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = 'El modelo de título se usa para resumir el primer mensaje del usuario en los chats nuevos.';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description} Actualmente hereda Activado de la configuración global.`;
  case 'disabled':
    return `${description} Actualmente hereda Desactivado de la configuración global.`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
