type TitleModelInheritance =
  | { readonly type: 'none' }
  | {
    readonly type: 'inherited',
    readonly state: 'enabled' | 'disabled',
    readonly source: 'chat' | 'chat_group' | 'global',
  };

export const ChatSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: TitleModelInheritance }): string => {
  const description = 'Das Titelmodell wird nur einmal verwendet, um die erste Benutzernachricht zusammenzufassen.';

  switch (inheritance.type) {
  case 'none':
    return description;
  case 'inherited': {
    const state = (() => {
      switch (inheritance.state) {
      case 'enabled':
        return 'Aktiviert';
      case 'disabled':
        return 'Deaktiviert';
      default: {
        const _ex: never = inheritance.state;
        throw new Error(`Unhandled title model state: ${_ex}`);
      }
      }
    })();

    switch (inheritance.source) {
    case 'chat':
      return `${description} Aktuell wird „${state}“ aus den Chat-Einstellungen geerbt.`;
    case 'chat_group':
      return `${description} Aktuell wird „${state}“ aus den Gruppeneinstellungen geerbt.`;
    case 'global':
      return `${description} Aktuell wird „${state}“ aus den globalen Einstellungen geerbt.`;
    default: {
      const _ex: never = inheritance.source;
      throw new Error(`Unhandled settings source: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${JSON.stringify(_ex)}`);
  }
  }
};
