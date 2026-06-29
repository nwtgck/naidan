import type { MimeCategory } from './types';

/** Map file extension → MimeCategory */
export const EXTENSION_MIME_MAP: Record<string, MimeCategory> = {
  // Text
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.json': 'text',
  '.jsonl': 'text',
  '.ts': 'text',
  '.tsx': 'text',
  '.js': 'text',
  '.jsx': 'text',
  '.mjs': 'text',
  '.cjs': 'text',
  '.vue': 'text',
  '.css': 'text',
  '.scss': 'text',
  '.less': 'text',
  '.html': 'text',
  '.htm': 'text',
  '.xml': 'text',
  '.yaml': 'text',
  '.yml': 'text',
  '.toml': 'text',
  '.svg': 'text',
  '.sh': 'text',
  '.bash': 'text',
  '.zsh': 'text',
  '.fish': 'text',
  '.py': 'text',
  '.rb': 'text',
  '.rs': 'text',
  '.go': 'text',
  '.java': 'text',
  '.kt': 'text',
  '.swift': 'text',
  '.c': 'text',
  '.cpp': 'text',
  '.cc': 'text',
  '.h': 'text',
  '.hpp': 'text',
  '.cs': 'text',
  '.php': 'text',
  '.lua': 'text',
  '.r': 'text',
  '.sql': 'text',
  '.env': 'text',
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.editorconfig': 'text',
  '.ini': 'text',
  '.cfg': 'text',
  '.conf': 'text',
  '.log': 'text',
  '.csv': 'text',
  '.tsv': 'text',

  // Images
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.tiff': 'image',
  '.tif': 'image',
  '.avif': 'image',

  // Video
  '.mp4': 'video',
  '.webm': 'video',
  '.ogg': 'video',
  '.ogv': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.mkv': 'video',

  // Audio
  '.mp3': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.aac': 'audio',
  '.opus': 'audio',
  '.oga': 'audio',
  '.m4a': 'audio',
};

/** Extension → highlight.js language alias */
export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.json': 'json',
  '.jsonl': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.sql': 'sql',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

/** Files larger than this require explicit "Load anyway" for text preview */
export const TEXT_PREVIEW_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB

/** Files larger than this require explicit "Load anyway" for media preview */
export const MEDIA_PREVIEW_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB

/** Batch size for reading file metadata (size, lastModified) in parallel */
export const METADATA_BATCH_SIZE = 50;

/** Debounce delay for the filter query input (ms) */
export const FILTER_DEBOUNCE_MS = 150;

/** Default icon view card width (px) */
export const ICON_VIEW_CARD_WIDTH = 96;

/** Default list view row height (px), used for virtual scrolling */
export const LIST_ROW_HEIGHT = 36;

/** Virtual scroll overscan (rows above/below visible area) */
export const VIRTUAL_SCROLL_OVERSCAN = 10;
