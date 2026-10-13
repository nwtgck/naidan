import type { FilesMessages } from '../../../site/messages';

export const strings = {
  "title": "Choose which files the AI can work with",
  "description": "Link a selected folder or work on a private copy, and choose read or write access.",
  "intro": [
    "Give the AI the files needed for a task, rather than access to the whole PC. Naidan lets you choose a working copy or a linked folder, then decide whether the AI can make changes."
  ],
  "diagramCaption": "Folder Copy creates a separate working copy. This example exposes that copy as read-only; the original folder stays on your device.",
  "methods": [
    {
      "title": "Folder Copy: try changes separately",
      "body": "Naidan imports the selected folder into browser storage. Edits affect that copy, not the original directory. Download the results when you are ready to use them elsewhere. Later edits to the original and the copy are independent.",
    },
    {
      "title": "Folder Link: work on the actual folder",
      "body": "A supporting browser lets you choose a real folder. Reads reflect its current contents. With both browser write permission and a writable mount, changes affect the original files. Use this when you deliberately want to work in place.",
    }
  ],
  "permissions": {
    "title": "Reading a file and changing it are separate permissions",
    "body": "A read-only mount is useful for reference material and project inspection. Allow writing for a folder you intend to edit. Folder selection, browser permissions and the effective mount configuration together determine access.",
  },
  "checklist": [
    {
      "title": "The folder",
      "body": "Choose a project or a smaller subfolder rather than a broad directory of unrelated files.",
    },
    {
      "title": "The scope",
      "body": "Global settings, Chat Group settings and Chat settings determine the mounts for a conversation. Check which folders this Chat actually exposes.",
    },
    {
      "title": "The destination",
      "body": "A linked folder changes original files; a copied folder changes browser-held data. Confirm the working location before asking for edits.",
    }
  ],
  "stepsTitle": "Add a working folder",
  "steps": [
    "Open the attachment menu beside the Chat input.",
    "Choose Folder Copy or Folder Link and select a folder. The choices available depend on browser capabilities.",
    "Check its mount path and access mode. Enable the Shell tool for the Chat when asking the AI to inspect or edit mounted files.",
    "Ask for a small inspection first, such as listing filenames. Review the result before permitting a larger edit."
  ],
  "next": "See how the browser controls access",
} satisfies FilesMessages;
