export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = 'Das Titelmodell wird verwendet, um die erste Benutzernachricht in neuen Chats zusammenzufassen.';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description} Derzeit wird „Aktiviert“ aus den globalen Einstellungen übernommen.`;
  case 'disabled':
    return `${description} Derzeit wird „Deaktiviert“ aus den globalen Einstellungen übernommen.`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
