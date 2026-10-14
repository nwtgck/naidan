export const storageChoiceDemoEn = {
  sectionTitle: 'Storage Management',
  fieldLabel: 'Active Storage Provider',
  options: {
    opfs: {
      title: 'Origin Private File System (OPFS)',
      description: "Save locally in the browser's high-capacity file system. Optimized for large data and attachments.",
    },
    local: {
      title: 'Local Storage',
      description: 'Save locally in the standard browser storage. Limited size (5-10MB). Sent images are NOT persisted.',
    },
    memory: {
      title: 'Ephemeral',
      description: 'In-memory storage. All data will be lost on page reload or tab closure. No persistent footprint.',
    },
  },
};

export type StorageChoiceDemoCopy = typeof storageChoiceDemoEn;
