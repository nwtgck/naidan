export const DeveloperTab__reset_data_provider_warning = ({ storageType }: { storageType: string }): string => (
  `Diese Aktion kann nicht rückgängig gemacht werden. Sie löscht dauerhaft den gesamten Chatverlauf, alle Chatgruppen und Einstellungen, die im Anbieter ${storageType} gespeichert sind.`
);
