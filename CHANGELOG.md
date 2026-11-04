# Changelog

<!--
This file is the canonical source for Naidan release notes.
Keep the Markdown format machine-readable: one "## [X.Y.Z] - YYYY-MM-DD"
heading per release. Version headings and reference labels omit the v prefix;
Git tag names in link destinations retain it. Use the standard Added, Changed, Deprecated, Removed,
Fixed, and Security categories as level-three headings; omit unused categories.
The [Unreleased] heading is reserved for changes not yet in a release.
Release tooling may edit version headings and move entries between sections.
Write entries in English, based on differences between the released source trees.
Commit messages can explain intent but are not authoritative evidence of behavior.
All release dates are UTC (Coordinated Universal Time) calendar dates.
Historical dates below are derived from Git tag timestamps converted to UTC,
not independently verified GitHub publication timestamps. Release preparation
uses today's UTC date unless --date explicitly supplies a UTC calendar date.
-->

All notable changes to Naidan are documented in this file.

## [Unreleased]

## [0.62.0] - 2026-11-02

### Added

- An experimental, temporary live-conversation workspace for compatible browser-local audio and multimodal models, with microphone or audio-file input, text, and optional images.
- Per-turn text/audio output controls, optional transcription, response interruption, and explicit approval before live-conversation shell tools run. Conversation media is not saved as normal chat history.
- A dedicated llama.cpp diagnostics page with link-configurable measurement settings and WebGPU capability information.

### Changed

- Combined Hugging Face model search and direct repository navigation in one input. Repository-like text remains a search query unless an explicit Hugging Face address is supplied.

## [0.61.0] - 2026-10-29

### Added

- ZIP archive browsing in File Explorer, including folder navigation and reading archive entries without first extracting the whole archive.
- A configurable bfloat16 vision-weight storage policy for compatible llama.cpp runtimes, with capability checks and diagnostic reporting.

## [0.60.0] - 2026-10-28

### Added

- Optional comparisons of WebGPU kernels for 8-bit quantized model operations, with subgroup information and bounded, cancellable diagnostic runs.

## [0.59.0] - 2026-10-27

### Added

- Live generation-speed indicators and per-turn measurements, distinguishing measured token rates from received-text estimates and server-reported statistics.

### Changed

- Made selected local model files usable before their browser-storage copy finishes, with separate saving progress and cancellation.

### Fixed

- Excluded source-folder publication markers from local model imports so those markers are not treated as authoritative state in browser storage.

## [0.58.0] - 2026-10-24

### Added

- Temporary local model imports that retain selected files for the current page without first copying them into persistent browser storage.
- A shared model-download view and reusable browser-model libraries for finding imported models and choosing them for a chat.

### Changed

- Reworked the welcome and local-model setup flow around model discovery and selection, with explicit recovery choices for unavailable models.

## [0.57.0] - 2026-10-18

### Added

- Optional synchronized per-operation decode timing for llama.cpp diagnostics. These intrusive measurements are kept separate from normal speed summaries.

### Changed

- Made the source of inherited model and title-reasoning settings more visible in chat and chat-group controls, including accessible labels.

## [0.56.0] - 2026-10-18

### Added

- Hugging Face model search with trending results, model-size filters, and pagination for browser-local model discovery.

### Changed

- Reorganized the chat composer and model/reasoning controls, including clearer presentation of inherited settings.

## [0.55.0] - 2026-10-16

### Added

- A documentation site with localized guides, browser-local generation walkthroughs, and search over the guide content.

## [0.54.0] - 2026-10-15

### Added

- Configurable context size for browser-local llama.cpp chat sessions, applied when allocating or recreating the chat context. Audio generation keeps its separate context settings.

## [0.53.0] - 2026-10-11

### Added

- Qwen Image 2.1 Turbo model choices with selectable `.gguf` variants in the experimental image catalog.

## [0.52.0] - 2026-10-10

### Added

- Experimental, explicitly configured Naidan-to-Naidan connections for using inference on another instance, including remote image-generation requests.
- Linked local model-folder inventories with permission checks and per-folder access issues, so models can be selected from supported external folders.

## [0.51.0] - 2026-10-06

### Changed

- Updated the bundled browser inference runtime used by the llama.cpp integration.

## [0.50.0] - 2026-10-05

### Added

- An experimental browser-local image-generation workspace in the hosted build, with model catalogs, guided downloads, generation previews, and image-to-image inputs.
- Per-run Low-Rank Adaptation (LoRA) controls and reusable generation settings. Saved image history requires origin-private browser storage.
- Session-based image workflows with optional chat assistance.

## [0.49.0] - 2026-09-24

### Added

- An experimental browser-local audio-generation workspace with model selection, reference-audio controls, playback, and a temporary history of generated audio.
- Separate controls for requesting completion of the current audio output and cancelling generation. Audio history is retained only while the workspace remains open.

## [0.48.1] - 2026-09-22

### Fixed

- Propagated cancellation through local model imports and allowed retries after empty placeholders left by interrupted imports. Non-empty conflicting directories are not silently deleted.

## [0.48.0] - 2026-09-22

### Added

- Bundled llama.cpp model suggestions that can be browsed without contacting Hugging Face, with explicit inspection and download actions for model variants.
- Live previews of tool-call arguments as they are generated, including incremental shell-script highlighting.

## [0.47.0] - 2026-09-22

### Added

- Browser-local llama.cpp chat in standalone packages on compatible WebGPU runtimes with JavaScript Promise Integration. Processor-only and Asyncify profiles remain unavailable in this build mode.

## [0.46.0] - 2026-09-20

### Added

- Experimental browser-local llama.cpp chat in the hosted build, using WebAssembly with supported WebGPU or processor-based runtime profiles.
- Local `.gguf` model imports and Hugging Face downloads, including compatible vision models with their required companion files.

## [0.45.0] - 2026-09-19

### Changed

- Expanded Transformers.js model-download reporting to distinguish transfer, saving, cached files, and completion, with estimated remaining time when available.
- Restricted Transformers.js worker loading to prepared model assets and build-owned runtime resources instead of allowing unexpected model network requests during initialization.

## [0.44.0] - 2026-08-29

### Added

- Simplified Chinese, Brazilian Portuguese, Spanish, Korean, and German interfaces, in addition to English and Japanese.

## [0.43.0] - 2026-08-29

### Added

- Language-specific standalone archives alongside the all-languages package, generated from the same validated application build.

## [0.42.0] - 2026-08-28

### Fixed

- Added a path-based fallback for browser-storage file and folder handles when the browser cannot transfer those handles to a worker, allowing affected File Explorer operations to continue.

## [0.41.0] - 2026-08-26

### Changed

- Reworked standalone packaging so the application and its workers can share JavaScript chunks, while keeping worker loading separate from document-only script and style handling.

## [0.40.0] - 2026-08-25

### Added

- Automatic writable `/workspace` volumes for chat shell sessions using Origin Private File System (OPFS) storage. Existing workspace mounts are preserved.

## [0.39.0] - 2026-08-24

### Added

- Local Git repository operations in Wesh, including staging, commits, history, branches, diffs, and merges within browser-accessible workspaces. Remote-style operations are limited to local repositories, not network Git hosting services.

## [0.38.0] - 2026-07-10

### Added

- Separate connection, model, and generation-parameter settings for automatic chat titles, with inheritance across global, chat-group, and chat settings.

## [0.37.0] - 2026-07-07

### Added

- Developer controls for inspecting and selectively deleting Naidan data from browser storage, with separate selection of storage areas and reporting of skipped or failed deletions.

## [0.36.0] - 2026-07-05

### Added

- An experimental connection to browser-provided language models through the Prompt API (Application Programming Interface), including availability checks and model-download progress. Text and image support depend on the browser implementation.

## [0.35.0] - 2026-07-04

### Changed

- Replaced the calculator engine with explicit exact-fraction and approximate-number modes, configurable precision, and more specific expression errors.

## [0.34.0] - 2026-06-30

### Added

- Folder downloads as ZIP archives from the file explorer, with path exclusions and cancellation.

### Fixed

- Global search retains the selected result when the result list changes.

## [0.33.0] - 2026-06-26

### Added

- Global, chat-group, and per-chat tool settings with explicit overrides, inheritance indicators, and reset-to-parent controls.

## [0.32.0] - 2026-06-20

### Added

- An Ollama runtime panel to inspect models held in server memory and request that they be unloaded.
- An interactive choices tool that lets a model present alternatives and wait for the user's selection.

## [0.31.1] - 2026-06-11

### Fixed

- Wikipedia requests in standalone builds now use a dedicated, validated fetch path without depending on the hosted privacy-fetch broker.

## [0.31.0] - 2026-06-10

### Added

- Wikipedia search and page-reading tools with approval prompts and restricted request policies.
- Context compaction that summarizes an earlier part of a conversation into a new branch while preserving the original history.

## [0.30.0] - 2026-05-19

### Added

- A conversation outline with message previews and jump-to-message navigation.
- Copyable links to individual messages in locally stored conversations.
- A title dialog with automatic saving and model-generated title suggestions.

## [0.29.0] - 2026-04-02

### Added

- Experimental Gemma 4 text-and-image model support through Transformers.js.

### Changed

- File-explorer list views render only the visible range and nearby entries instead of every row.

## [0.28.1] - 2026-04-01

### Fixed

- Missing file icons in binary-object previews, the attachment browser, and the conversation inspector.

## [0.28.0] - 2026-04-01

### Added

- A file explorer for browser storage and workspace volumes.
- Per-chat terminal sessions that share mounted volumes with the shell tool, including chat-group mount settings.

### Changed

- The experimental volume and Wesh feature flags are enabled by default for new configurations.

## [0.27.0] - 2026-03-21

### Added

- A Wesh `time` command for reporting elapsed command time.

### Fixed

- Standalone packaging now finishes inlining the application and embedding workers before creating the release archive.

## [0.26.0] - 2026-03-21

### Added

- An opt-in experimental Wesh shell tool and developer terminal that run inside the browser.
- Experimental workspace volumes, including importing files and linking a folder selected by the user.

## [0.25.0] - 2026-03-10

### Added

- Experimental tool calling, including a calculator and visible multi-step tool execution in conversations.

### Fixed

- Imported conversations retain the selected branch after message identifiers are remapped.

## [0.24.1] - 2026-03-04

### Fixed

- Unset per-chat language-model parameters no longer erase inherited global or chat-group values.

### Changed

- Transient generation errors are no longer saved as part of stored conversations.

## [0.24.0] - 2026-03-04

### Added

- Inherited reasoning-effort settings for OpenAI-compatible and Ollama endpoints that support them.
- A print view for conversations.
- A language preference for reading messages aloud.

## [0.23.1] - 2026-02-28

### Changed

- Transformers.js model acquisition now discovers model files in a separate worker and pre-downloads them into browser storage before model initialization.

## [0.23.0] - 2026-02-28

### Added

- Installation and offline caching of application assets for the hosted app. Models and remote inference services have their own availability requirements.
- An experimental block-based Markdown renderer with collapsible content and controls for loading external images.

## [0.22.0] - 2026-02-26

### Added

- A lightweight Python server that serves Naidan release archives without unpacking them, with optional endpoint reverse proxying and content security policy settings.
- Export options to omit conversations or binary attachments.

### Changed

- Onboarding recognizes Ollama at the selected local endpoint while keeping connection confirmation under the user's control.

## [0.21.0] - 2026-02-23

### Added

- Conversation-sharing links that contain exported chat data, with append-mode import that preserves existing chats and connection settings.
- Switch between the expanded text editor and a plain text area.

### Changed

- Open conversations at the latest user message and keep message navigation within the chat's scroll container.

## [0.20.0] - 2026-02-21

### Changed

- Reworked the expanded text editor around a line-based text model and added Emacs-style editing shortcuts.

## [0.19.0] - 2026-02-21

### Added

- Select a storage mode through a setup link on first use, without replacing an already configured storage mode.

### Changed

- Make text-editor statistics optional and defer wrapped-line measurements while typing.

## [0.18.0] - 2026-02-20

### Added

- A recent-chat switcher for returning to conversations opened during the session.
- Per-chat and chat-group controls for automatic title generation and its model, with inherited defaults.
- A Copy Raw action that preserves a message's original text.

## [0.17.0] - 2026-02-19

### Added

- A media shelf for browsing a conversation's attached and generated images, copying generation prompts, and jumping to their messages.

## [0.16.0] - 2026-02-19

### Added

- Share setup links that preconfigure an OpenAI-compatible or Ollama endpoint.
- Find chat groups by name in global search, with a preview of the group's conversations.

## [0.15.0] - 2026-02-17

### Added

- An ephemeral storage mode that keeps conversation data in memory until the page is reloaded or closed.
- Display generation parameters alongside generated images.

## [0.14.0] - 2026-02-16

### Added

- Configure image-generation steps and seeds and display progress reported by the endpoint.
- Download generated PNG and WebP images with optional embedded prompt, model, step, and seed information.

## [0.13.0] - 2026-02-16

### Added

- Compare message versions with highlighted text differences and copy individual versions.
- An expanded text editor with search and replace, regular-expression matching, and undo/redo.

## [0.12.0] - 2026-02-15

### Added

- Edit attached images before sending them, with rectangular or elliptical selections, cropping, masking, resizing, and undo/redo.
- Show Transformers.js download and initialization status in the conversation and browser-tab title, including loading errors.

## [0.11.0] - 2026-02-14

### Changed

- Added clickable ancestor-folder breadcrumbs and a refresh action to the browser-storage explorer.

### Fixed

- Reuse already downloaded files when retrying an incomplete model download, and exclude incomplete models from chat selection.

## [0.10.0] - 2026-02-14

### Changed

- Show per-file model-download progress and byte totals, and distinguish partially cached models from complete downloads.

## [0.9.0] - 2026-02-14

### Added

- An experimental GPT-OSS model option for Transformers.js, with parsing for its reasoning and answer channels.

### Changed

- Ship compressed WebAssembly runtime files for hosted Transformers.js builds, with a fallback to uncompressed files.

## [0.8.0] - 2026-02-13

### Added

- Search conversation content across branches, with chat and chat-group filters and result previews.
- Stop an active response directly from its message controls.

## [0.7.1] - 2026-02-11

### Fixed

- Decode generated-image data directly instead of fetching data links, and allow local image previews under the hosted site's content security policy.

## [0.7.0] - 2026-02-11

### Changed

- Added collapsible message content and image browsing to the conversation-tree inspector.

### Fixed

- Escape and sanitize chat data before displaying syntax-highlighted raw data in the inspector.

## [0.6.0] - 2026-02-11

### Added

- Direct links to a selected conversation branch and chat-group duplication.
- A conversation-tree inspector and custom width and height controls for image generation.

### Changed

- Load stored-image thumbnails incrementally in the binary-object manager.

### Fixed

- Wait for an interrupted generation to finish stopping before editing or regenerating, while retaining its partial output.

## [0.5.0] - 2026-02-08

### Added

- Generate multiple images in sequence, display each completed result as it arrives, and choose the format used to store them.
- A larger stored-image preview with browsing, download, and deletion controls.

## [0.4.0] - 2026-02-08

### Added

- Preserve unsent text and image attachments while navigating between chats.
- A binary-object manager for browsing and deleting stored attachments.

### Changed

- Migrated persisted attachments to the binary-object storage layout while updating existing message references.

## [0.3.0] - 2026-02-06

### Added

- Experimental browser-local text generation through Transformers.js in hosted builds, with model downloads and cache management.
- Image generation through compatible Ollama endpoints, including resolution controls and reference-image attachments.
- Browser-provided speech playback for messages.
- Super Edit for editing an entire conversation into a new branch, including messages, attachments, and the system prompt.

## [0.2.0] - 2026-01-30

### Changed

- Added compact chat-group lists with show-more controls and keyboard navigation in the sidebar.
- Refined composer expansion and focus handling when moving between the sidebar and a conversation.

### Fixed

- Deferred chat deletion until the undo notification closes, so undo can restore the conversation before its stored data is removed.
- Stopped an active response before regenerating or editing it and closed interrupted reasoning blocks.

## [0.1.0] - 2026-01-27

### Added

- Initial release with streaming chat, branching message histories, chat groups, and per-chat settings.
- Connections to OpenAI-compatible and Ollama endpoints, with model selection and reusable connection profiles.
- Browser-local conversation storage, data import and export, and a downloadable standalone application.

[Unreleased]: https://github.com/nwtgck/naidan/compare/v0.62.0...develop
[0.62.0]: https://github.com/nwtgck/naidan/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/nwtgck/naidan/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/nwtgck/naidan/compare/v0.59.0...v0.60.0
[0.59.0]: https://github.com/nwtgck/naidan/compare/v0.58.0...v0.59.0
[0.58.0]: https://github.com/nwtgck/naidan/compare/v0.57.0...v0.58.0
[0.57.0]: https://github.com/nwtgck/naidan/compare/v0.56.0...v0.57.0
[0.56.0]: https://github.com/nwtgck/naidan/compare/v0.55.0...v0.56.0
[0.55.0]: https://github.com/nwtgck/naidan/compare/v0.54.0...v0.55.0
[0.54.0]: https://github.com/nwtgck/naidan/compare/v0.53.0...v0.54.0
[0.53.0]: https://github.com/nwtgck/naidan/compare/v0.52.0...v0.53.0
[0.52.0]: https://github.com/nwtgck/naidan/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/nwtgck/naidan/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/nwtgck/naidan/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/nwtgck/naidan/compare/v0.48.1...v0.49.0
[0.48.1]: https://github.com/nwtgck/naidan/compare/v0.48.0...v0.48.1
[0.48.0]: https://github.com/nwtgck/naidan/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/nwtgck/naidan/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/nwtgck/naidan/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/nwtgck/naidan/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/nwtgck/naidan/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/nwtgck/naidan/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/nwtgck/naidan/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/nwtgck/naidan/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/nwtgck/naidan/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/nwtgck/naidan/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/nwtgck/naidan/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/nwtgck/naidan/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/nwtgck/naidan/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/nwtgck/naidan/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/nwtgck/naidan/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/nwtgck/naidan/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/nwtgck/naidan/compare/v0.31.1...v0.32.0
[0.31.1]: https://github.com/nwtgck/naidan/compare/v0.31.0...v0.31.1
[0.31.0]: https://github.com/nwtgck/naidan/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/nwtgck/naidan/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/nwtgck/naidan/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/nwtgck/naidan/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/nwtgck/naidan/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/nwtgck/naidan/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/nwtgck/naidan/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/nwtgck/naidan/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/nwtgck/naidan/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/nwtgck/naidan/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/nwtgck/naidan/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/nwtgck/naidan/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/nwtgck/naidan/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/nwtgck/naidan/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/nwtgck/naidan/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/nwtgck/naidan/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/nwtgck/naidan/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/nwtgck/naidan/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/nwtgck/naidan/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/nwtgck/naidan/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/nwtgck/naidan/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/nwtgck/naidan/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/nwtgck/naidan/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/nwtgck/naidan/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/nwtgck/naidan/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/nwtgck/naidan/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/nwtgck/naidan/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/nwtgck/naidan/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/nwtgck/naidan/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/nwtgck/naidan/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nwtgck/naidan/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nwtgck/naidan/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nwtgck/naidan/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nwtgck/naidan/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nwtgck/naidan/releases/tag/v0.1.0
