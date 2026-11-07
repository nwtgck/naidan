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

## [0.65.0] - 2026-11-07

### Added

- Publish repository-specific browser model pages for Unsloth's Qwen3.8-Flash-Next and ISTA DASLab's Qwen3.8-27B GSQ-RCO, with explicit variant names in generated and live page metadata. Record editorial model naming for every published repository independently of the suggested-model catalog.
- Publish browser model pages and sitemap entries for Google Gemma 4 12B QAT and LiquidAI LFM3-1.7B and LFM3-VL-2B without adding them to the suggested-model catalog.
- Searchable repository-specific browser model pages, generated from the shared registry with local/on-device metadata, canonical URLs, and sitemap entries. Optional `?quant=` selects a quantization; unlisted repositories open the same preview through the static app fallback. Starting a chat returns to the existing fragment route without reloading. Model routes do not inject `noindex`, including for unlisted or invalid repositories.
- Experimental workflows with shared step, JSON, and scoped graph editing, reusable parts, typed values, sequential text generation, branching, loops, interactive input, and folder-based file operations. Graph connections and moves validate scope and downstream types, preserve undo history, and protect unfinished inputs.
- Workflow execution history with immutable definition snapshots, bounded progress checkpoints, individual workflow/run links, result browsing, and streamed archive downloads. Abandoned runs can be explicitly marked as interrupted without replay; per-run ownership locks protect active runs and pending completion saves. Composable arithmetic and boolean values support conditional loop completion and configurable execution-wide budgets.
- Local Workflow audio and image generation through the existing browser engines, with typed dynamic inputs and sequential batching through loops. Audio generation supports reference voices and an explicit incomplete-output policy; image generation supports bounded initial/reference images and transient previews while fixing model and component file locations rather than substituting missing files.
- Session- and run-scoped model connection approvals that preserve value origins, separate text/audio/image authority, and do not survive imports or history copies. Binary results remain usable when optional text previews cannot be decoded, and cancellation preserves completed outputs without publishing unfinished generation.
- Explicit Workflow tool steps for calculator, Wikipedia search/page retrieval, and an isolated Wesh shell with one selected folder, plus bounded model-selected rounds using these tools and interactive choices. Typed arguments compose with model outputs and loops; external access is reviewed per call, historical tool records are never replayed, and tool failures or truncated shell output stop explicit steps unless error outputs are requested.
- On-demand Workflow image, audio, and conversation viewers, fixed-choice input, and copying completed Workflow conversations into new chats. Copies do not inherit tool permissions or automatically generate responses or titles. Structure-only exports remove authored content and connection/folder bindings separately from full-fidelity backups.

### Fixed

- Fail Privacy Fetch requests when the sandboxed broker cannot start, release its resources, and allow the next request to try a fresh broker instead of waiting indefinitely.
- Restore browser-local llama.cpp model operations in environments that cannot clone file-system handles to workers, using captured file snapshots without reopening model paths. Preserve source identity checks for resident-model reuse and prevent cancelled preparation from dispatching late work.
- Check file-system-handle cloning before worker initialization or linked-folder downloads, retaining the confirmed download root and avoiding retries of already-started operations after remote clone errors.
- Drain active shell-tool executions before releasing their execution records after cancellation, and clear completed shell-tool timeout timers.

### Changed

- Link README models and the English/Japanese browser-model guide shortlist to repository pages while preserving the existing link origins and Docs' current-origin handling. Hosted builds and ZIPs include model pages directly; standalone builds remain free of them. Model pages retain subdirectory mounts. Hosted archives include the final service worker and its precached universal offline download when available.
- Persist llama.cpp browser endpoints with the stable `llama_cpp_browser` type on their next save while continuing to read existing `experimental_type` records without rewriting them on load. Other experimental endpoints and settings are unchanged.
- Rename user-facing llama.cpp browser labels to “llama.cpp in the browser” (localized in each language) and list it first among concrete endpoint choices, without changing inherited choices or default connections.
- Open the endpoint choices together with connection details in chat and chat-group overrides. Selecting an endpoint closes only the choices; clicking the connection summary again closes the details.

## [0.64.0] - 2026-11-06

### Added

- Added a translation workspace in Quick Access with an inline model catalog and model drawer, initially supporting PLaMo 3 Translate GGUF models with automatic or manual translation, searchable language selection, streamed output, cancellation, Japanese style, reference context, and terminology controls.
- Translation prepares the selected model independently of text edits, supports automatic translation during input composition with an adjustable delay, and retains the previous output until replacement text arrives.
- Translation remembers only the selected model and automatic-translation preferences (enabled state and input delay) in experimental settings. The previous boolean-only auto-translation preference is discarded. Languages are controlled by the `from` / `to` URL parameters; previous experimental language preferences are discarded. Source text, output, context, and terminology are not persisted, and the default chat model is unchanged.

### Changed

- GitHub Release descriptions now use the curated `CHANGELOG.md` notes, including corrections to previously published releases.

### Security

- Protect connection header values and in-flight RPC pairing codes with `Secret<T>` to prevent accidental diagnostic disclosure, while preserving existing persistence, ZIP export, and chat URL sharing behavior.
- Mask nested title-generation credentials in Wesh sysfs, including remote-reader payloads before they reach a worker.

## [0.63.0] - 2026-11-04

### Changed

- Updated the bundled llama.cpp browser runtime to llama.cpp 0.9.0.

### Fixed

- Preserved native runtime output and JavaScript error details across llama.cpp browser worker boundaries, with expandable, copyable details for model-loading and chat failures.

## [0.62.0] - 2026-11-02

### Added

- An experimental, temporary live-conversation workspace for compatible browser-local audio and multimodal models on WebGPU/JSPI runtimes, with microphone or audio-file input, text, and optional images.
- Per-turn text/audio output controls, optional input transcription, response interruption, and explicit approval before each live-conversation shell-tool batch runs. Conversation media is not saved as normal chat history. Interrupting removes the current turn, including its input, from the model context and marks it as discarded in the workspace; it does not undo approved filesystem writes.

### Changed

- Moved llama.cpp diagnostics to a dedicated page with URL-configurable measurement settings and WebGPU capability information. Opening a configured URL does not start a run.
- Removed the previous 16-model and 128 MiB archive-output limits from llama.cpp diagnostics, with streamed ZIP exports where supported.
- Combined Hugging Face model search and direct repository navigation in one input. Repository-like text is searched; explicit Hugging Face HTTPS URLs open model details.

### Fixed

- Prevented a failed model-details lookup from leaving the previous model enabled for download.

## [0.61.0] - 2026-10-29

### Added

- Read-only ZIP browsing in File Explorer, including nested archives, file previews and downloads, copying selected entries to writable folders, and viewing generated exports before downloading them.
- A Hugging Face repository preview for choosing model files, optional multimodal companions, and download destinations before starting a browser-local model.
- A configurable bfloat16 vision-weight storage policy for compatible llama.cpp runtimes, with capability checks and diagnostic reporting.
- A fixed-image diagnostic workload for comparing first-load and resident vision-model runs, with image-stage observations in exported investigations.

### Changed

- Made attached files and folders usable while they are copied into browser storage, with progress, pause, resume, and retry controls. Unfinished copies remain tied to the current page session.
- Remembered separate queries for global, chat, and chat-group searches during the current page session.

### Fixed

- Kept file and folder attachments associated with the chat where attachment began, even if the user switches chats before it finishes.
- Improved search keyboard navigation and text editing, including IME input, and prevented result updates or a stationary pointer from unexpectedly changing the keyboard target or active selection.
- Prevented concurrent browser-folder updates from losing folder-list entries, and stopped treating unreadable folder-list metadata as an empty index.

## [0.60.0] - 2026-10-28

### Added

- Optional, bounded and cancellable comparisons of WebGPU Q8 kernels using synthetic test inputs in the hosted profiling runtime, with subgroup information and separate diagnostic exports. These are kernel diagnostics, not model-speed comparisons.

### Changed

- Separated time waiting for prior computation from checkpoint serialization and readback in llama.cpp diagnostics.

## [0.59.0] - 2026-10-27

### Added

- Live generation-speed indicators and per-turn measurements, distinguishing measured token rates from received-text estimates and server-reported statistics.
- Automatic companion-file selection and supported recommended settings for remote image generation when the connected peer supplies a compatible model catalog.
- Copying backup ZIPs as Base64 and importing pasted Base64 through the existing preview and verification flow.
- Contextual guidance for connections and downloads that may be restricted by Content Security Policy, including explicit options to use local model files or move data to another Naidan edition.
- Browser-storage or linked-folder download destination selection directly in the chat's Hugging Face model picker.
- A local-model files view and download guide in browser-model onboarding, with a local-files default when connection guidance indicates restricted Hugging Face access, while preserving manual view choices.

### Changed

- Local GGUF imports now use the original files immediately without copying them by default, with optional background or later saving, separate progress and cancellation, and confirmed repository boundaries for related variants and companion files. Unsaved imports are available only until the page is reloaded or closed.
- Enabled saving tool-configuration changes by default while preserving an explicit opt-out. This does not enable the tools themselves.

### Fixed

- Fixed BPE whitespace tokenization at llama.cpp chat-template boundaries so eligible conversation and tool-call history can reuse the prompt cache and avoid false context-limit errors.
- Prevented background local-model changes from changing remote image-generation settings or clearing its reference images.
- Avoided unnecessary image-model reloads when unchanged companion files are reordered.
- Honored image-generation cancellation during preview encoding without starting final encoding.
- Fixed navigation to chat groups selected from global search.
- Kept keyboard focus in documentation search when its results change.
- Excluded source-folder publication markers from local model imports so those markers are not treated as authoritative state in browser storage.

## [0.58.0] - 2026-10-24

### Added

- Temporary local model imports that retain selected files for the current page without copying them into persistent browser storage, including image and audio workflows and RPC serving. Temporary language models can be saved for later use.
- Shared browser-model libraries and a unified download view for language and image models.
- Hosted llama.cpp GPU profiling with a compatible diagnostic runtime and supported browser capabilities.
- The ability to interrupt a benchmark trial and continue independent trials while retaining partial results.
- An effective reasoning-effort indicator beside the chat model selector.
- Qwen3.8-Flash-Next 125B model suggestions.

### Changed

- Unified downloads for llama.cpp language models and browser-local image models under a shared session-wide queue with per-file progress, pause, resume, retry and cancellation. Downloads continue when switching views.
- Reworked the welcome screen and model-connection setup around recent chats, model discovery, imports, linked folders and explicit recovery choices for unavailable models.
- Browser language models now use readable repository/variant identifiers. Models using legacy encoded file references or obsolete linked-folder aliases may need to be selected again.
- Updated Naidan RPC to the incompatible v2 peer contract with modelId-based catalogs and chat requests. Connected peers must use compatible versions.
- Made portable ZIP packaging reproducible for identical package contents by sorting entries and normalizing timestamps.

### Removed

- The 64-bit CPU llama.cpp runtime. Hosted CPU fallback now uses the 32-bit runtime; 64-bit WebGPU remains available.

### Fixed

- Preserved existing history when storage reads fail, and prevented stale background writes or history edits from overwriting newer conversation content and model selections.
- Persisted branch selections made through message links while protecting unsaved history edits.
- Prevented duplicate chat creation and stale navigation during retries, and improved recovery for missing chats and unreadable storage without resending query prompts.
- Fixed clipping of long expanded chat groups and improved scrolling to the active sidebar item.
- Preserved model files when download destinations or pending operations change, and protected replacement folders and unselected files during model removal.
- Prevented auxiliary model files from being mistaken for installed chat models, and stopped completed image downloads from being marked paused when cancellation arrives during completion checks.
- Corrected generated license asset hashes so changed license information refreshes cached assets without invalidating unchanged content.

## [0.57.0] - 2026-10-18

### Added

- Optional synchronized per-operation decode timing for llama.cpp diagnostics. These intrusive elapsed-time measurements are kept separate from normal speed summaries and are not GPU-kernel-only timings.

### Changed

- Made the source of inherited model and title-reasoning settings more visible in chat and chat-group controls, including accessible labels.

### Fixed

- Preserved special-token spellings in user-provided llama.cpp chat text as literal input instead of interpreting them as chat-template control tokens.

## [0.56.0] - 2026-10-18

### Added

- Hugging Face model search with trending results, parameter-count filters, and pagination for browser-local model discovery.
- Create a chat group directly from an installed llama.cpp browser model.
- Copy shareable launch links for supported Hugging Face model variants.

### Changed

- Reorganized the chat composer and global, chat, and group settings, with clearer model/reasoning controls and inherited settings.
- Automatically select newly linked folders for downloading text-generation and image-generation models.

### Fixed

- Improved composer resizing and scroll positioning when editing input or reading older messages.
- Prevent Ctrl/Cmd+Enter from sending messages during IME composition.
- Keep pending settings and folder operations associated with their original chat or group, with clearer save errors and retry behavior.
- Report errors when importing dropped folders instead of leaving failed directory reads pending.

## [0.55.0] - 2026-10-16

### Added

- An English/Japanese documentation site in hosted deployments, with browser-local generation guides, searchable content, interactive branching examples, and a browser-AI availability check. The documentation site is not bundled in downloadable application ZIPs.

## [0.54.0] - 2026-10-15

### Added

- Configurable context size for browser-local llama.cpp chat sessions, applied when allocating or recreating the chat context. Actual allocation may be smaller because of model or memory limits; audio generation keeps its separate context settings.
- Support for reading model rows from their backing files during inference when the llama.cpp runtime provides that capability.

### Changed

- Simplified public local-model names and kept ambiguous variants out of the selectable list. Saved selectors using the old split-count suffixes or encoded Host aliases may no longer resolve; reselect affected models.
- Aligned Wesh carriage-return handling with Bash: carriage returns are literal characters rather than line separators.

### Fixed

- Fixed Wesh here-document parsing and expansion, including multiple documents on one command line, and prevented large here-documents from hanging.
- Prevented a previously selected browser-stored model from resolving to a different file during generation or deletion if its original file disappears.

## [0.53.0] - 2026-10-11

### Added

- Qwen Image 2.1 Turbo model choices with selectable `.gguf` variants in the experimental image catalog.
- Loaded-model details, Flash Attention configuration observations, and the build-time Naidan source revision, when available, in exported llama.cpp investigation archives.

### Changed

- Updated browser page titles and descriptions for model launches and generation workspaces, with coordinated loading and printing titles.

## [0.52.0] - 2026-10-10

### Added

- Experimental, explicitly configured Naidan-to-Naidan connections for remote chat and image generation, including standalone callers, per-connection method permissions and optional saved startup connections.
- Linked local folder inventories and direct downloads for llama.cpp language models, with permission checks and per-folder access issues.
- A llama.cpp browser performance investigation screen for comparing saved models and exporting measurement reports.
- llama.cpp browser memory diagnostics for WebAssembly memory capacity and cumulative GPU API requests, plus a Firefox WebGPU performance advisory.
- Individual recommended-value controls and a compact progress-only view for image generation.
- Streaming image-prompt translations, recent results retained in workspace memory, and workspace/session-specific translation model-parameter overrides.

### Changed

- Image runtime settings can be edited for the next generation while a run is active; editing settings or switching sessions no longer passively unloads retained image models.
- Removed browser reload warnings during image generation while retaining in-app navigation confirmations. Unsaved outputs still do not survive a reload.
- Reduced unnecessary image-model rescans after successful imports and OPFS downloads and when switching image sessions.

### Fixed

- Offline update handoffs wait for active downloads, avoid redundant same-build prompts and prevent overlapping updates from removing a newer installation's cached assets.
- Retained unsaved image outputs for download and save retries without regenerating, and preserved the requested batch size when persistent image storage is unavailable. Retention is in memory, not recovery after a reload.
- Prevented delayed image-history saves from restoring deleted records or publishing into a replaced history store, and made image-session recency ordering resilient to clock changes and interrupted saves.
- Restored image-session drafts without waiting for the gallery, kept previews and diagnostics with their own session, and resolved model references against the current inventory.
- Kept queued image preference changes tied to their original storage provider. Storage switches now keep the old provider active until migration succeeds and correctly record local-storage fallback when OPFS is unavailable.
- Stopped treating empty or output-limited prompt translations as local model failures.
- Kept image and audio workspaces accessible before chat setup, and allowed Send to reopen incomplete inherited global setup without losing or automatically submitting the draft.
- Kept message action menus and sidebar quick access usable on small, resized or scrolled viewports.
- Prevented ambiguous GGUF names and split-file grouping collisions from selecting the wrong local model.

## [0.51.0] - 2026-10-06

### Changed

- Updated the bundled browser inference runtime used by the llama.cpp integration.

## [0.50.0] - 2026-10-05

### Added

- An experimental browser-local image-generation workspace in the hosted build on compatible WebGPU browsers, with model catalogs, guided downloads, generation previews, image inputs and per-run LoRA controls.
- Saved image sessions with seed batches, favorites and tags, setting reuse, comparisons and session ZIP export. Saved sessions and history require origin-private browser storage.
- Optional chat-based prompt assistance and prompt translation for image generation.
- Image-generation benchmarks with fresh and warm model sessions, diagnostics and result exports.
- Model-link launch and missing-model recovery for browser-local llama.cpp chats, with explicit selection and download of the required model files.

### Changed

- Automatic chat titles now wait for idle time and yield to typing and foreground generation.
- Chat, backup, File Explorer and diagnostic exports use streaming downloads when a compatible hosted service worker is available, with compatibility saving elsewhere.
- Reduced browser-local llama.cpp startup and generation overhead through metadata caching and more efficient prompt/output processing.

### Fixed

- Delayed automatic titles no longer overwrite manual titles or revive deleted chats; title-generation parameters are preserved when switching endpoints or models.
- Explicit browser-local llama.cpp model selections no longer silently fall back to another installed model during generation.
- Bounded virtual-file previews read only enough to detect the preview limit, and unsupported binary previews avoid payload reads.
- OPFS binary deletion failures are reported without discarding the corresponding records.

## [0.49.0] - 2026-09-24

### Added

- An experimental browser-local audio-generation workspace with model selection, reference-audio controls, playback, and a temporary history of generated audio.
- Separate controls for requesting completion of the current audio output and cancelling generation. Audio history is retained only until leaving or reloading the audio workspace.

### Changed

- Showed PWA update preparation status and added an option to reload to the network version before offline preparation finishes, when supported by the active service worker. Offline use may be temporarily unavailable after choosing this option.
- Allowed Hugging Face model downloads in the curated hosted deployment.

### Fixed

- Fixed llama.cpp WebGPU inference failures caused by direct compute dispatches exceeding the device's per-dimension workgroup limit, by splitting supported dispatches into bounded chunks.

## [0.48.1] - 2026-09-22

### Fixed

- Propagated cancellation through local model imports and allowed retries after empty placeholders left by interrupted imports. Non-empty conflicting directories are not silently deleted.
- Fixed local model files and folders being ignored when dropped or selected while the model list was refreshing.

## [0.48.0] - 2026-09-22

### Added

- Bundled llama.cpp model suggestions that can be browsed without contacting Hugging Face, with explicit inspection and download actions for model variants.
- Live tool-call argument previews for supported backends, including OpenAI-compatible and llama.cpp connections, with incremental shell-script highlighting.
- Search imported local models, choose a local model as the global default, and save individual model files to the device.
- A session-wide llama.cpp model-download queue with progress, pause, resume and retry. Transfers continue when leaving settings, but queued intentions do not survive a page reload.

### Changed

- Conversation history now preserves ordered text, reasoning, attachments and tool calls/results, with partial completion and separate interruption records. Existing saved chats remain readable; new writes use the updated format.
- Shell-visible chat JSON and Markdown under `/sys/fs/naidan` now expose ordered message parts, `createdAt` and interruption records instead of the previous flat message fields. Attachment JSON uses `name` instead of `originalName`; scripts consuming these formats may need updating.
- Local-model requests now report unsupported attachments and message-part ordering, such as text after a tool call or non-leading reasoning.
- Reused verified common llama.cpp prompt prefixes after conversation edits, with host-side checkpoints for compatible caches and full prompt processing when reuse cannot be validated.

### Fixed

- Preserved accepted partial output after interrupted or malformed generation, and prevented incomplete or unconfirmed tool calls from executing. Retained observed tool outcomes after save failures or late cancellation, and kept stale callbacks from affecting replacement turns.
- Retried assistant responses after completed tool results without rerunning historical tools.
- Preserved reasoning, tool results and other message details during conversation editing, saved changes to the originally opened chat, and persisted edited system prompts.
- Rejected incomplete or unsuccessful compaction summaries and automatic titles instead of accepting partial results.
- Reported unreadable saved chats and binary-object indexes instead of treating them as empty and overwriting them; retained accepted in-memory responses after save failures and prevented launch prompts from being sent to the wrong chat after a load failure.
- Kept legacy attachment migration retryable without deleting source files when migration cannot complete safely.
- Validated selected chat contents before destructive import writes, preserved fork origins regardless of import order, and remapped generated-image and binary tool-result references during append imports. Chat-sharing URLs now include generated images, binary tool results and unsaved attachments from all exported branches.
- Previewed and downloaded original in-memory image attachments without requiring saved files, and prevented stale image loads or list reordering from replacing the current preview selection.
- Preserved literal thinking-tag examples in code and escaped text, and corrected ordered tool/result display and conversation outlines.

## [0.47.0] - 2026-09-22

### Added

- Browser-local llama.cpp chat in standalone packages on compatible WebGPU runtimes with JavaScript Promise Integration. Processor-only and Asyncify profiles remain unavailable in this build mode.
- Browser capability checks and runtime-profile availability explanations, including a WebGPU wasm32 JSPI option for the hosted build.

### Fixed

- Prevented unavailable Transformers.js endpoints from being selected or used in standalone chat and title settings.

## [0.46.0] - 2026-09-20

### Added

- Experimental browser-local llama.cpp chat in the hosted build, using WebAssembly with supported WebGPU or processor-based runtime profiles.
- Local `.gguf` model imports and Hugging Face downloads, including compatible vision models with their required companion files.

### Changed

- Separated Chat Inspector access from Debug Mode, with a dedicated action in the chat header menu.
- Required an ONNX graph for Transformers.js model listings and preserved unrelated files when deleting a Transformers.js model from shared model storage.
- Changed the experimental endpoint settings format. Previously saved browser-provided language-model endpoint selections must be selected again.

## [0.45.0] - 2026-09-19

### Added

- A current-conversation JSON view and copying for both current-conversation and full-chat JSON in Chat Inspector.
- Multi-model configuration for support investigations, with offline and download-focused diagnostic presets, explicit external-fetch controls, per-model skipping and batch stopping, retained in-page results, and ZIP evidence exports. Investigations do not download full models. Reports distinguish failed, unexecuted, observed, and successfully executed checks rather than treating collection completion as proof of model correctness.
- Export of retained download-timing observations without starting a new investigation or model download.
- Native streamed tool-call parsing and tool-history template handling for compatible LFM and Gemma 4 models.
- Image input for compatible three-session Qwen 3.5 models using the prepared vision model and native chat template.
- Wesh `rg` recursive text search with ignore files, glob/type filters, context, file listings, and common match-output options, plus a syntax-check-only `node --check` command.
- Wesh `git grep` for tracked working-tree files and `git blame` for committed text, including line ranges, porcelain output, and moved/copied-line attribution.
- Wesh Git history and diff options for following a file through renames, custom show formats, name-only/status output, context length, plain word diffs, and literal binary patches; abbreviated object IDs and config value-pattern filtering.
- Wesh `cp --parents`; reference-file and bulk-input dates, relative expressions in `date`, and absolute-date-plus-offset expressions in `touch`; `find -newermt`, formatted output, and directory-local command execution; gzip listing and recursive compression; time/size/reverse directory sorting; and additional process selection, sorting, and tree output.
- Wesh `file -h`/`--no-dereference` and `-E` controls for symlink inspection and filesystem-error exit status.
- Wesh sed shell-execution commands/flags, ZIP update/freshen/delete/move modes, and interactive unzip overwrite choices.

### Changed

- Expanded Transformers.js model-download reporting to distinguish transfer, saving, cached files, and completion, with per-candidate progress and estimated download time when available.
- Separated explicit model preparation/download from cache-only loading. Required files and shards are checked before loading, completed downloads are reused, and Resume prepares missing resources before loading.
- Restricted Transformers.js workers to prepared model assets and verified build-owned runtime resources, with bounded startup and retirement of failed workers before replacement.
- Removed the implicit 1,024-token generation limit while preserving model-context limits and explicit generation settings.
- Serialized Transformers.js model operations and complete tool loops, with request-scoped cancellation and ownership checks during worker restarts.
- Loaded Wesh commands on demand, with idle preloading, and reduced repeated work in shell scanning and Git history/object processing.
- Expanded command-specific GNU-style long-option abbreviations and Bash startup/option compatibility, including supported SHELLOPTS/BASHOPTS settings and PATH lookup for slashless script names.

### Fixed

- Transformers.js loads hanging on failed external-data downloads, failed session initialization blocking later attempts, and partially initialized sessions being left behind after another session fails.
- Transformers.js generation-block chat-template rendering, native prompt/reasoning boundaries, schema-aware Qwen 3.5 tool arguments, and tool-result continuation input/cache handling for compatible models, including GPT-OSS and Qwen 3.5.
- Stream completion racing pending host callbacks, and stale callbacks or interrupted queued operations affecting a later model request.
- Incomplete or invalid model responses being accepted as completed files, failures being mistaken for unavailable model variants, and races between cooperating cache readers, writers, and deletion. Unsupported persistent writers now fail instead of reporting a successful save.
- Chat printing being affected by application overlays/layout, and horizontal scrolling being blocked across File Explorer columns.
- Wesh AWK byte-string, paragraph, numeric-field, and formatting compatibility; nullable-alternative jq regex matching; and diff hunk alignment under case/whitespace ignoring.
- Wesh relative output paths in `split` and `xxd`, incremental output in `fold` and `tail -n +N`, and sed unbuffered input consuming bytes beyond an early quit.
- Wesh backup suffix handling and source-alias protection in `mv`, per-file error handling in `paste`, unzip archive suffix fallback and escaped/negated patterns, and consistent filesystem diagnostics across affected commands.
- Wesh Git pathspec-filtered status and clean behavior, rename-aware history searches, and revision-path lookup being affected by unrelated subtrees.

## [0.44.0] - 2026-08-29

### Added

- Simplified Chinese, Brazilian Portuguese, Spanish, Korean, and German interfaces, in addition to English and Japanese.

### Changed

- Kept the language selector visible in language-specific standalone packages, showing the package language while disabling language changes.

## [0.43.0] - 2026-08-29

### Added

- Language-specific standalone archives alongside the all-languages package, generated from the same validated application build. Portable App download links select the current interface language's archive.
- A Delete Chat action in the chat header menu.

### Changed

- Deleting the current chat now returns to its chat group when it belongs to one.

### Fixed

- Fixed Wesh Git compatibility for configuration parsing and writing, branch and remote cleanup, clean safety, and history filtering.
- Fixed Wesh sed compatibility, including interruptible long-running scripts, unbuffered output, and preservation of original files when in-place editing fails or is interrupted.
- Fixed Wesh shell script handling for nested substitutions, quoted text, heredoc bodies, and shebang arguments.

## [0.42.0] - 2026-08-28

### Fixed

- Fixed OPFS-backed File Explorer and shell operations in browsers that cannot transfer file-system handles to workers. The fallback does not support directories outside OPFS.
- Fixed browsing chat data in File Explorer when using local or in-memory storage.

## [0.41.0] - 2026-08-26

### Changed

- Reworked standalone packaging so the application and its workers can share JavaScript chunks, while keeping worker loading separate from document-only script and style handling.

### Fixed

- Fixed standalone background workers being left running after initialization failures or cancellation of an unresponsive shell command.
- Fixed Wesh Git option parsing, diff exit statuses, commit and tag messages, and handling of branch deletion and merge-conflict resets.
- Enforced Wesh Git force-with-lease checks when deleting branches in local remote repositories.
- Fixed Wesh sed parsing, address ranges and early-quit behavior, including error handling during in-place editing.
- Fixed Wesh shell quoting and nested parameter and command substitutions.

## [0.40.0] - 2026-08-25

### Added

- Automatic writable `/workspace` volumes for chat shell sessions using Origin Private File System (OPFS) storage. Existing workspace mounts are preserved.

### Changed

- Detaching a workspace folder preserves its stored files; only empty, unreferenced OPFS volumes are cleaned up.

### Fixed

- Improved Wesh sed compatibility for C/UTF-8 locale handling, GNU-style escapes and regex delimiters, multiline replacements, and text-command boundaries.

## [0.39.0] - 2026-08-24

### Added

- Local Git repository operations in Wesh, including staging, commits, history, branches, diffs, and merges within browser-accessible workspaces. Remote-style operations are limited to local repositories, not network Git hosting services.
- A hosted-build diagnostic interface for downloaded Hugging Face models, with limited runtime/model checks and export of partial diagnostic evidence as ZIP.
- Wesh `set`, `kill`, `type`, and `umask` builtins.
- xxd reverse conversion from normal or plain hexadecimal dumps, including binary file patching.

### Changed

- Transformers.js model loading now tries WebGPU q4f16, WebGPU q4, then WASM q4, replacing the previous default-dtype fallback attempts.
- Expanded Wesh awk with user-defined functions, getline and shell pipelines, output redirection, range patterns, additional arithmetic and mathematical functions, and more compatible record, field and printf handling.
- Expanded Wesh shell execution, sourcing and function scope, positional and parameter expansion, condition handling, redirection and set -e/-u/-o pipefail support.
- Expanded jq with user-defined filters, reduce/foreach, additional regex/date/format functions, input handling and generator/path-update support, with compatibility fixes to evaluation and number representation.
- Expanded sed with hold and multiline pattern spaces, branching and grouping, additional commands and addressing, separate-file and NUL modes, and in-place backup options.
- Expanded xml sel with nested matches, conditional templates, namespace bindings and broader XPath support. Output is XML-escaped by default; use -T for plain text.
- Wesh zip updates existing archives while retaining unrelated entries and can write archives to stdout. ZIP handling also improves source timestamps, symlink behavior, duplicate-name checks and integrity testing. Archive output names without a dot now gain a `.zip` extension.
- Improved Wesh utility compatibility, including byte-oriented cut -c and tr, literal printf %s output (use %b for escapes), command execution through env, and find size/regex semantics.

### Fixed

- Tool-result persistence completes before generation is marked finished, and historical tool calls retain their model-visible transcript representation.
- Transformers.js downloads can continue through the main downloader when preliminary file discovery or prefetch is incomplete, and frequent download-progress updates are throttled to reduce UI load.
- Improved shell file-descriptor lifetime and cleanup across functions, compound commands and subshells, and preserved invalid UTF-8 bytes through supported substitutions and redirections.

## [0.38.0] - 2026-07-10

### Added

- Separate connection, model, and generation-parameter settings for automatic chat titles, with inheritance across global, chat-group, and chat settings.

### Changed

- Reset explicit model selections when switching endpoint type or URL.

### Fixed

- System-prompt settings retain in-progress text when switching between inherited, disabled, replacement, and appended prompts.
- Image-generation progress now appears during the initial waiting state and shows the active step from the start.

## [0.37.0] - 2026-07-07

### Added

- Developer controls for inspecting and selectively deleting Naidan data from browser storage, with separate selection of storage areas, deletion previews, runtime-availability warnings, and failure reporting.
- Additional Wesh utilities for file comparison, directory listings, checksums, patching, text layout, and splitting files: `cmp`, `tree`, `column`, `nl`, `sha256sum`, `patch`, `du`, `split`, and `csplit`.

### Fixed

- Assistant errors remain visible even when no message content was generated.
- Preserved binary-object creation timestamps when importing storage data into memory or OPFS storage.

## [0.36.0] - 2026-07-05

### Added

- An experimental connection to browser-provided language models through the Prompt API (Application Programming Interface), including availability checks and model-download progress. Text and image support depend on the browser implementation.
- Wesh `diff` and `stat` commands for comparing files and inspecting file metadata.

### Fixed

- Preserved attachment MIME types when loading binary files from OPFS storage.
- Prevented outdated model-list responses from overwriting model selections after switching connections.
- Applied the profile’s title model when selecting a provider profile for a chat or group.
- Used an available model when regenerating a response whose previous model is no longer available.

## [0.35.0] - 2026-07-04

### Changed

- Replaced the calculator engine with exact rational arithmetic where possible, configurable decimal output precision, and more specific expression errors. The calculator uses a restricted expression language; some previously supported mathjs functions and syntax are no longer available.

### Fixed

- Improved Transformers.js generation cancellation and serialized worker restarts after engine failures.
- Prevented stale file-preview results from replacing the current selection and cleaned up pending preview resources when closed.

## [0.34.0] - 2026-06-30

### Added

- Folder downloads as ZIP archives from the file explorer, with path exclusions and cancellation.
- English and Japanese interface translations, with a language selector in onboarding and settings.
- ZIP uploads with a choice to keep the archive or extract its contents, including preserving or removing a single enclosing folder.
- Long-press file action menus for touch and pen input, cancelled by pointer movement or pointer cancellation.

### Changed

- Virtualized global search results, avoided loading attachment bodies during text search, and used iterative traversal for deep chat trees. Empty searches show title lists across scopes, with saved search display settings and more reliable previews.

### Fixed

- Global search retains the selected result when the result list changes.
- Applied the saved theme before application startup and coordinated onboarding, sidebar rendering, and initial navigation to avoid premature interactions.
- Inherited connection settings as one complete endpoint instead of combining type, URL, and headers from different setting levels; preserved explicitly empty URLs and replaced old headers when selecting connection presets.
- Prevented stale model-list and sidebar responses from replacing newer results, and refreshed model lists when HTTP headers change.

## [0.33.0] - 2026-06-26

### Added

- Global, chat-group, and per-chat tool settings with explicit overrides, inheritance indicators, and reset-to-parent controls.
- Interactive open-source license browsing in the standalone About screen.

### Changed

- Standalone builds lazily load application and worker assets through SystemJS and reuse generated asset URLs.
- Experimental saved tool configurations now require explicit enabled/disabled status; older configurations without status may need to be configured again.

### Fixed

- Show startup failures in the application page and initialize correctly when the document has already loaded.
- Preserved saved tool settings during chat metadata updates and forks, serialized tool-setting saves, and surfaced save failures.

## [0.32.0] - 2026-06-20

### Added

- An Ollama runtime panel to inspect models held in server memory and request that they be unloaded.
- An interactive choices tool that lets a model present alternatives and wait for the user's selection.
- ZIP export controls to omit chats or attachments, and a selected-branch-only export option for ZIP files and export URLs.
- Opt-in experimental persistence of enabled chat tools and Wesh Naidan-data access scope.
- Terminal command/path completion, per-session command history with draft restoration, a current-directory prompt and Ctrl+L clearing.

### Changed

- Expanded Wesh `jq` filters, builtins, input/output modes, filter files, variables, and exit-status handling. Output is now pretty-printed by default (`-c` for compact output), with semicolon-separated function arguments and improved multi-result and assignment behavior.
- Reduced whole-input buffering across Wesh commands, including streaming ZIP operations, external-merge sort and streaming xargs. Sort and some ZIP operations now use writable temporary storage; xargs may execute completed batches before a later input error.

### Fixed

- Preserved unsaved chat and chat-group settings while synchronizing changes made elsewhere.
- Marked still-running tool calls as interrupted when generation is cancelled.
- Wesh now reaps completed command and child-shell processes, preserves literal arguments in direct command execution, and rejects exclusive creation of existing files without overwriting them.

### Security

- Hardened Mermaid rendering and highlighted code output, and applied protected new-tab handling to external Markdown links.

## [0.31.1] - 2026-06-11

### Fixed

- Wikipedia requests in standalone builds now use a dedicated, validated fetch path without depending on the hosted privacy-fetch broker.

## [0.31.0] - 2026-06-10

### Added

- Wikipedia search and page-reading tools with approval prompts and restricted request policies.
- Context compaction that summarizes an earlier part of a conversation into a new branch while preserving the original history.
- Read-only access to Naidan chat data through `/sys/fs/naidan`, with selectable chat visibility, plus browsing, previewing and downloading virtual files in File Explorer.

### Changed

- Shell tools can run with LocalStorage or memory storage without a writable /tmp mount.

## [0.30.0] - 2026-05-19

### Added

- A conversation outline with message previews and jump-to-message navigation.
- Copyable links to individual messages in locally stored conversations.
- A title dialog with automatic saving and model-generated title suggestions.
- An experimental option to move chats to the top of their group or top-level chat list when sending a message.
- Developer controls to open or copy the current storage state to alternate official deployments, optionally excluding chats or attachments.

### Changed

- Keep the latest user message at the top when a response begins, with space reserved for incoming output.

## [0.29.0] - 2026-04-02

### Added

- Experimental Gemma 4 text-and-image model support through Transformers.js.

### Changed

- File-explorer list views render only the visible range and nearby entries instead of every row.
- Chat scrolling follows the first assistant response or tool group once per turn.
- Moved syntax highlighting, file-explorer work, and advanced-editor search and replacement to workers to reduce main-thread work. Code blocks retain plain text while highlighting loads or fails.

### Fixed

- Allow undoing single and bulk replacements in the expanded text editor, and prevent zero-width regular-expression searches from looping indefinitely.
- Restored read-only lock icons in the file explorer and preserved original JSON text when switching between raw and formatted previews.
- Report an error when a Transformers.js download-only scan finds no model files instead of reporting an incomplete download as successful.

## [0.28.1] - 2026-04-01

### Fixed

- Missing file icons in binary-object previews, the attachment browser, and the conversation inspector.

## [0.28.0] - 2026-04-01

### Added

- A file explorer for browser storage and workspace volumes.
- Chat-accessible terminal sessions initialized with chat and chat-group mounted volumes shared with the shell tool. Existing terminal sessions remain shared across chats.
- Attach files and folders to chats through file selection or drag and drop, copying them into browser storage or linking supported host folders, with read-only mounts by default.
- Tool calling for supported in-browser Transformers.js models, including Qwen3.5 and gpt-oss handling.
- Filter message-content search by user or assistant role.
- Live shell-command output, configurable execution timeouts, and terminal command cancellation with Ctrl+C.
- Expanded Wesh scripting with while/until loops, case statements, functions, command substitution, arithmetic, conditional expressions, and trailing redirections on compound commands.
- Wesh `base64`, `fold`, `mktemp`, `ps`, `strings`, `unalias`, and `xxd` commands.

### Changed

- The experimental volume and Wesh feature flags are enabled by default for new configurations.
- Tool enablement is tracked separately for each chat during the app session; chats with mounted volumes automatically enable the shell tool.
- Standalone builds now keep main JavaScript in external assets rather than inlining it into the HTML; keep the unpacked assets alongside the HTML file.
- Reduced buffering when processing files and text in several Wesh commands.

### Removed

- The legacy HTML Markdown renderer and its developer toggle; messages now use block-based rendering.

### Fixed

- Chat-specific endpoint settings survive storage reloads and ordinary chat updates.
- Changing search scopes or filters reruns the query, and IME composition Enter no longer activates results prematurely.
- Reveal selected chats hidden by compact groups and keep the selected chat in view.
- Keep generation error details visible after in-app chat reloads and storage synchronization.
- Improved pipe and stream cleanup and interruption of shell commands blocked on output, plus binary handling and output fidelity in `head`, `cut`, and `tail`.
- Avoid redundant download scanning for fully cached Transformers.js models and prevent worker-transfer failures caused by reactive message, parameter, or tool data.

### Security

- Shell tools now honor read-only volume mounts.

## [0.27.0] - 2026-03-21

### Added

- A Wesh `time` command for reporting elapsed command time.
- Worker-backed developer-terminal tabs that retain session history while the app remains open and can access configured volumes.

### Fixed

- Standalone packaging now finishes inlining the application and embedding workers before creating the release archive.

## [0.26.0] - 2026-03-21

### Added

- An opt-in experimental Wesh shell tool, plus a developer terminal, running inside the browser with pipelines and built-in file, text, JSON, XML, and archive tools.
- Experimental workspace volumes, including importing files and linking a folder selected by the user.

### Changed

- Avoid repeated automatic scrolling during a tool-assisted reply.

### Fixed

- Preserved pending chat-setting edits when switching chats or closing the settings panel, and reloaded current settings when reopening it.

## [0.25.0] - 2026-03-10

### Added

- Experimental tool calling, including a calculator and visible multi-step tool execution in conversations.
- Export an individual conversation as a shareable URL.
- Display streamed reasoning from OpenAI-compatible endpoints that use reasoning or reasoning_content fields.

### Changed

- Use block-based Markdown rendering by default while retaining the legacy HTML option.
- Include thinking and tool execution details in Markdown exports.
- Apply imported UI, experimental, and automatic-title preferences.

### Fixed

- Imported conversations retain the selected branch after message identifiers are remapped.
- Preserve generation parameters when resending a message.

## [0.24.1] - 2026-03-04

### Changed

- Transient generation errors are no longer saved as part of stored conversations.

### Fixed

- Unset per-chat language-model parameters no longer erase inherited global or chat-group values.

## [0.24.0] - 2026-03-04

### Added

- Inherited reasoning-effort settings for OpenAI-compatible and Ollama endpoints that support them.
- A print view for conversations.
- A language preference for reading messages aloud.
- Code-block line wrapping in the experimental block Markdown renderer.

### Changed

- Retain per-message generation parameters and reuse them when regenerating.

### Fixed

- Display math rendering in the experimental block Markdown renderer.
- Read-aloud waits for further streamed sentences and reads the final unfinished fragment after generation ends.

## [0.23.1] - 2026-02-28

### Changed

- Transformers.js model acquisition now discovers model files in a separate worker and pre-downloads them into browser storage before model initialization.

## [0.23.0] - 2026-02-28

### Added

- Installation and offline caching of application assets for the hosted app. Models and remote inference services have their own availability requirements.
- An experimental block-based Markdown renderer with collapsible content and controls for loading external images.
- Stop in-progress chat-title generation independently.

### Fixed

- Title-generation and model-loading indicators reflect the active chat only.

## [0.22.0] - 2026-02-26

### Added

- A lightweight Python server that serves Naidan release archives without unpacking them, with optional endpoint reverse proxying and content security policy settings.
- Export options to omit conversations or binary attachments.

### Changed

- Onboarding recognizes Ollama at the selected local endpoint while keeping connection confirmation under the user's control.
- Changed the Recent Chats shortcut from Ctrl/Cmd+E to Ctrl/Cmd+P.
- Model-picker search accepts multiple terms in any order.
- Collapsed reasoning displays a live preview during generation.

## [0.21.0] - 2026-02-23

### Added

- Conversation-sharing links that contain exported chat data, with append-mode import that preserves existing chats and connection settings.
- Switch between the expanded text editor and a plain text area.
- Image sequence indicators and original dimensions in generated-image information.

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

### Changed

- Regular message copying now excludes reasoning blocks and internal image-request markers; use Copy Raw to preserve the original text.
- Global search retains the query when reopened and expands previews by click or keyboard navigation.

### Fixed

- Generated-image metadata now records the step count reported by the endpoint, omitting it when unavailable rather than recording the requested value.
- Stabilized global-search input during rapid typing.

## [0.17.0] - 2026-02-19

### Added

- A media shelf for browsing a conversation's attached and generated images, copying generation prompts, and jumping to messages in the current branch.
- Global search can list chats without a query in title-only mode and offers an on-demand preview mode.

### Changed

- Search uses sidebar order rather than last-update order, with group and title matches presented before content-only matches.

## [0.16.0] - 2026-02-19

### Added

- Share setup links that preconfigure an OpenAI-compatible or Ollama endpoint.
- Find chat groups by name in global search, with a preview of the group's conversations.

### Changed

- Global search now starts in title-only mode; select a content-search scope to search messages.

### Fixed

- Prevented chat-input and sidebar keyboard handling from interfering with global search.

## [0.15.0] - 2026-02-17

### Added

- An ephemeral storage mode that keeps conversation data in memory until the page is reloaded or closed.
- Display generation parameters alongside generated images.
- Skip selected message versions when comparing revisions, with incremental loading for long version histories.

### Changed

- Improved loading and layout stability for generated images.

## [0.14.0] - 2026-02-16

### Added

- Configure image-generation steps and seeds and display progress reported by the endpoint.
- Download generated PNG and WebP images with optional embedded prompt, model, step, and seed information.

### Changed

- Image generation now uses Ollama's streaming `/api/generate` endpoint instead of `/v1/images/generations` for text-to-image requests.

### Fixed

- Kept the message actions menu within the viewport.

## [0.13.0] - 2026-02-16

### Added

- Compare message versions with highlighted text differences and copy individual versions.
- An expanded text editor with search and replace, regular-expression matching, multi-occurrence editing, and undo/redo.
- Image-editor zoom and pan, custom mask colors with an eyedropper and recent colors, and confirmation before discarding edits.

### Changed

- The image editor now defaults to PNG output; choose Original to retain the input format.
- The hidden chat input now peeks on hover and stays open after being focused.

## [0.12.0] - 2026-02-15

### Added

- Edit attached images before sending them, with selections, cropping, masking, resizing, rotation, flipping, output-format selection, and undo/redo.
- Show Transformers.js download and initialization status in the conversation and browser-tab title, including loading errors.

### Fixed

- Removed completed reasoning blocks from automatically generated chat titles.
- Surface model-cache write failures and invalid HTML model responses, and reset the Transformers.js worker after memory-allocation failures.

## [0.11.0] - 2026-02-14

### Added

- Clickable ancestor-folder breadcrumbs, refresh, and a preview toggle in the browser-storage explorer.

### Fixed

- Reuse already downloaded files when retrying an incomplete model download, and exclude incomplete models from chat selection.

## [0.10.0] - 2026-02-14

### Changed

- Show per-file model-download progress, downloaded byte counts and estimated totals, with expandable asset details.
- Exclude partially written caches and caches without model weights from the downloaded-model list.

## [0.9.0] - 2026-02-14

### Added

- An experimental GPT-OSS model option for Transformers.js, with parsing for its reasoning and answer channels.

### Changed

- Ship compressed WebAssembly runtime files for hosted Transformers.js builds, with a fallback to uncompressed files.

## [0.8.0] - 2026-02-13

### Added

- Search conversation titles and messages across branches with Cmd/Ctrl+K, chat and chat-group filters, result previews, and navigation to matching branches.
- Stop an active response directly from its message controls.
- Explicitly inherit system prompts and preview inherited prompts in chat and chat-group settings.
- Rectangular image-generation presets, width/height swapping, and additional image-count presets.

### Changed

- Keep sidebar, image and diagram actions accessible on touch devices.

### Fixed

- Prevent the chat-tools menu from being clipped by its surrounding layout.

## [0.7.1] - 2026-02-11

### Fixed

- Decode generated-image data directly instead of fetching data links, and permit blob URLs under the local-only hosted deployment's content security policy.

## [0.7.0] - 2026-02-11

### Added

- Collapsible message content, image browsing, and an action to open a selected leaf from the conversation-tree inspector.

### Security

- Escape and sanitize chat data before rendering raw JSON in the inspector, including when syntax highlighting is disabled.

## [0.6.0] - 2026-02-11

### Added

- Direct links to a selected conversation branch and duplication of chat-group settings into a new, empty group.
- A fullscreen conversation inspector with active-branch, tree and JSON views.
- Custom width and height controls for image generation.
- Hide the composer and reveal it again on hover or focus, retaining the hidden state across chat switches.

### Changed

- Load stored-image thumbnails incrementally in the binary-object manager.
- Move theme selection into Settings and debug/storage controls into the sidebar.
- Ask for confirmation before deleting files or folders in the browser-storage explorer.

### Fixed

- Wait for an interrupted generation to finish stopping before editing or regenerating, retaining completed image results and partial text.
- Clear the image-generation indicator after cancellation or failure.
- Avoid repeated OPFS migrations during ordinary storage operations, and coordinate initialization between tabs where browser locking is available.

## [0.5.0] - 2026-02-08

### Added

- Generate multiple images in sequence, display each completed result as it arrives, and choose the format used to store them.
- Edit image-generation settings on existing messages and convert between text messages and image-generation requests before resending.
- Open stored attached or generated images in a fullscreen preview with zoom, panning, keyboard browsing, download, and deletion controls.

## [0.4.0] - 2026-02-08

### Added

- Keep separate unsent text and image-attachment drafts for each chat during the current page session.
- A binary-object manager with search, sorting, grid/table views, image previews, downloads, and deletion.

### Changed

- Migrate persisted attachments to the binary-object storage layout while updating existing message references.
- Store newly generated images as separate binary objects when using OPFS, and use the binary-object layout for exported and imported attachment archives. Older archives using uploaded-files no longer restore their attachment files.

### Fixed

- Finishing a send in a previous chat no longer clears the draft of the newly opened chat.

## [0.3.0] - 2026-02-06

### Added

- Experimental browser-local text generation through Transformers.js in hosted builds, with Hugging Face downloads, local ONNX model imports, and cache management. Requires browser OPFS storage.
- Image generation through compatible Ollama endpoints, with size presets for text-to-image generation and reference-image attachments.
- Browser-provided speech playback for messages, including pause/resume and streamed responses.
- Super Edit for editing the active conversation branch, including messages and attachments, while preserving its existing history. Chat-wide system-prompt settings are also editable.
- Initialize a new chat's system prompt through the system-prompt or sp URL parameter alongside q, and open Settings tabs through URLs.
- Clear inherited system prompts in chat and chat-group settings and exported group recipes.

### Fixed

- Keep the model selector open when the mobile keyboard changes viewport height.
- Preserve unrelated settings changed concurrently when saving a settings field.

## [0.2.0] - 2026-01-30

### Added

- Compact chat-group lists with show-more controls, keyboard sidebar navigation, and direct chat-group URLs.
- Keyboard model selection with a floating selector that adapts to available space.

### Changed

- Refine composer expansion and focus handling when moving between the sidebar and a conversation.
- Reuse the conversation view to reduce flicker and retain the shared composer contents when switching chats.

### Fixed

- Defer chat deletion until the undo notification closes, so undo can restore the conversation before its stored data is removed.
- Request cancellation of an active response before regenerating or editing it, and close interrupted reasoning blocks.

## [0.1.0] - 2026-01-27

### Added

- Initial release with streaming chat, branching message histories, chat groups, and global, group and per-chat settings.
- Connections to OpenAI-compatible and Ollama endpoints, with model selection and reusable connection profiles.
- Image attachments through file selection, paste and drag/drop.
- Rich Markdown with syntax-highlighted code, mathematical notation, Mermaid diagrams, and collapsible reasoning.
- Shareable JSON chat-group recipes with model-matching rules.
- URL parameters for starting chats with a message, model and chat group.
- Concurrent responses in different chats and synchronization between browser tabs.
- Browser-local conversation storage, data import/export, standalone browser downloads, and a local HTTP-server executable.

[Unreleased]: https://github.com/nwtgck/naidan/compare/v0.65.0...develop
[0.65.0]: https://github.com/nwtgck/naidan/compare/v0.64.0...v0.65.0
[0.64.0]: https://github.com/nwtgck/naidan/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/nwtgck/naidan/compare/v0.62.0...v0.63.0
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
