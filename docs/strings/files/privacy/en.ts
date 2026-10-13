export const strings = {
  "demo": {
    "device": "On your device",
    "otherFolders": "Other folders",
    "folderCopy": "Folder (copy)",
    "mountedFolder": "Mounted folder",
    "readOnly": "READ ONLY",
    "copy": "copy",
    "access": "Reading allowed · Writing disabled",
  },
  "title": "Choose which files and folders AI can read or edit",
  "description": "Give AI access to a single file or selected folders in Naidan. Compare folder copies and links, choose read or write access, and check where changes are saved.",
  "intro": [
    "Give the AI only the files needed for a task. Choose one file, a working copy of a folder, or a linked folder, then decide whether the AI can make changes."
  ],
  "launch": { "before": "Open ", "after": " and choose or create the Chat where you want to use the file or folder. You can close first-time setup with × to attach it. Before asking AI to inspect a mounted file or folder, finish setup with a working endpoint and a model that supports tool calls." },
  "modelGuide": { "before": " For an in-browser model, see ", "link": "browser model setup", "after": "." },
  "diagramCaption": "［Folder (copy)］ creates a separate working copy. This example exposes that copy as read-only; the original folder stays on your device.",
  "methods": [
    {
      "title": "［Folder (copy)］: try changes separately",
      "body": "Naidan imports the selected folder into browser storage. Edits affect that copy, not the original directory. Download the results when you are ready to use them elsewhere. Later edits to the original and the copy are independent.",
    },
    {
      "title": "［Folder (link)］: work on the actual folder",
      "body": "A supporting browser lets you choose a real folder. Reads reflect its current contents. With both browser write permission and a writable mount, changes affect the original files. Use this when you deliberately want to work in place.",
    }
  ],
  "permissions": {
    "title": "Reading a file and changing it are separate permissions",
    "body": "A read-only mount is useful for reference material and project inspection. Allow writing only for a mounted file or folder you intend to edit. Folder selection, browser permissions and the effective mount configuration together determine access to device folders. Separately, when ［Shell］ and /sys/fs/naidan are mounted, Shell can list and read every saved binary file shown in Settings ［Files］, including files from other chats. ［Current chat］ limits chat history there, not those saved files; it does not open unselected device folders.",
  },
  "checklist": [
    {
      "title": "The file or folder",
      "body": "Choose one file, a project folder or a smaller subfolder rather than a broad directory of unrelated files.",
    },
    {
      "title": "The scope",
      "body": "Global settings, Chat Group settings and Chat settings determine the mounts for a conversation. Check which files or folders this Chat actually exposes.",
    },
    {
      "title": "The destination",
      "body": "A linked folder changes original files; a copied folder changes browser-held data. Confirm the working location before asking for edits.",
    }
  ],
  "stepsTitle": "Add a file or working folder",
  "steps": [
    "Open the attachment menu beside the Chat input.",
    "For one non-image file, choose ［Files］ and select it. Naidan copies it into browser storage, mounts the copy read-only, and enables ［Shell］ for this Chat; skip the folder choice in the next step. Images selected alone through ［Files］ are message attachments instead. To have AI read an attached image, configure a working endpoint and a model that accepts image input before sending the message.",
    "For a folder, choose ［Folder (copy)］ or ［Folder (link)］ and select the folder. The choices available depend on browser capabilities. If you selected a non-image file in step 2, continue with step 4.",
    "Check the mount path and read-only access above the Chat input. For a mounted file or folder, ［Shell］ is enabled for this Chat; a model that supports tool calls can use it to inspect the contents. An image attached to a message does not follow these mount steps.",
    "Ask for a small inspection first, such as reading a few lines or listing filenames, and review the result. If you then want an edit, select the lock beside the mounted item above the Chat input to allow writing; a linked folder also needs browser write permission."
  ],
  "next": "Understand local AI processing and browser permissions",
  nextDescription: 'Trace how a permitted file reaches local AI and where browser access ends.',
  relatedExplorer: {
    title: 'Browse and manage files',
    description: 'Open File Explorer to preview, upload, download, or organize files yourself.',
  },
  relatedSettings: {
    title: 'Manage files and folders in Settings',
    description: 'Review saved files and the working folders available to a Chat.',
  },
};
