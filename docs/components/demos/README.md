# Source-derived documentation demonstrations

Docs deliberately owns independent replicas of application presentation.
Duplication is intentional: do not share or import the application’s UI
components, stores, providers, browser file handles or model runtimes. This keeps
static Docs deterministic and independent of model assets. Reproduce important
layout and interactions accurately using current source and tests. UI labels,
sample conversations, diagram text and accessible labels follow the page locale.
Static demonstrations read the selected article or common messages through a
typed prop during server rendering. Registered islands prepare their own small
messages for that locale before server rendering and client hydration; they do
not receive the article catalog as JSON props. Keep genuine commands, paths,
filenames and tool identifiers in their authentic form.

## Source counterparts

Use the current `src/` implementation and its behavior tests as the reference.
Check the following counterparts when updating a demonstration; old archives
and previous Docs versions do not define current application behavior.

| Demonstration | Application counterparts |
| --- | --- |
| `ReplicaChrome.vue`, `../BrowserMock.vue` | `src/components/Sidebar.vue`, `src/components/ChatPaneHeader.vue`, `src/components/ChatInput.vue`, `src/components/MessageItem.vue`, `src/components/MessageActions.vue`; `src/components/ChatInput.test.ts`, `src/components/Sidebar.test.ts` |
| `FolderAccessDemo.vue` | `src/components/ChatAttachMenu.vue`, `src/components/VolumeMountList.vue`, folder link/copy entries; `src/features/tools/wesh/chat-workspace.test.ts` |
| `FileExplorerStep.vue` | `src/components/SidebarDebugControls.vue`; `src/features/file-explorer/components/{FileExplorerModal,FileExplorerToolbar,FileExplorerBreadcrumbs,FileExplorerPreviewPanel,FileExplorerZipUploadDialog,FileExplorerDirectoryDownloadDialog}.vue`; `src/features/file-explorer/composables/` and component behavior tests |
| `ShellWorkspaceDemo.vue` | `src/components/AssistantProcessSequence.vue`, `src/features/tools/components/ShellExecuteToolCall.vue`, `src/features/tools/components/ToolCallItem.vue`; `src/features/tools/components/ShellExecuteToolCall.test.ts` |
| `ShellEnableStep.vue` | `src/components/ChatInput.vue`; `src/features/tools/components/{ChatToolsMenu,LmToolsSettings,ToolConfigHierarchySettings}.vue`; `src/features/tools/tool-config.ts`, `src/01-models/feature-flags.ts`; `src/features/tools/components/{ChatToolsMenu,LmToolsSettings}.test.ts` |
| `FilesSettingsStep.vue` | `src/components/{Sidebar,SettingsModal,BinaryObjectsTab,VolumeCreator,VolumeSettingsTab,VolumeMountList}.vue`; `src/composables/useBinaryActions.ts`, `src/logic/chat-settings-resolver.ts`, `src/features/tools/wesh/create-shell-execute-tool.ts`; `src/components/{BinaryObjectsTab,VolumeSettingsTab}.test.ts` |
| `WikipediaSettingsStep.vue` | `src/components/ChatInput.vue`; `src/features/tools/components/{ChatToolsMenu,LmToolsSettings,ToolConfigHierarchySettings}.vue`; `src/features/tools/tool-config.ts` and its behavior tests |
| `WikipediaChatStep.vue` | `src/components/ChatPane.vue`; `src/features/tools/components/{ToolCallItem,chat-approval/ChatApprovalPanel,chat-approval/ChatApprovalDecisionList}.vue` and `chat-approval/previews/{WikipediaSearchApprovalPreview,WikipediaGetPageApprovalPreview}.vue`; `src/features/tools/wikipedia/{tools,render}.ts` and their behavior tests |
| `../../islands/branching/BranchingDemo.vue` | `src/components/MessageActions.vue`, `src/components/MessageActionsMenu.vue`, `src/components/MessageItem.vue`, `src/logic/chat-tree.ts`; `src/components/MessageActionsMenu.test.ts`, `src/logic/chat-tree.test.ts` |
| `StandaloneDemo.vue` | root `README.md`, Standalone package layout and download instructions |
| `OfflineGuideStep.vue` | `build/pwa.ts`, `pwa/sw.ts`, `src/logic/pwa/update-controller.ts`, `src/composables/pwa-update-runtime.ts`; `src/components/{PWAManager,PWAUpdateNotification,Sidebar,SidebarDebugControls,DebugPanel}.vue`; `src/components/PWAUpdateNotification.test.ts`, `src/logic/pwa/update-controller.test.ts` |
| `BoundaryDiagram.vue` | root `README.md`, nested OS/browser boundaries, browser API and permission paths, localhost engine connections |
| `ConnectionPolicyDiagram.vue` | root `README.md` “Other hosted variants” and `.github/workflows/main.yml` Hosted, Local-only and Curated `_headers` policies |
| `ConnectionSettingsStep.vue` | `src/components/Sidebar.vue`, `SettingsModal.vue`, `ConnectionTab.vue`, `ModelSelector.vue`, `ServerSetupGuide.vue`; `src/components/SettingsModal.test.ts`; `src/constants.ts` local endpoint presets |
| `OpenAiCompatibleSettingsStep.vue` | `src/components/SettingsModal.vue`, `src/components/ConnectionTab.vue`, `src/components/ModelSelector.vue`, `src/components/ServerSetupGuide.vue`; `src/constants.ts` local endpoint presets; `src/features/lm/openai.ts` model-list request |
| `BrowserModelSettingsStep.vue` | `src/components/SettingsModal.vue`, `src/components/ConnectionTab.vue`; `src/features/llama-cpp-browser/components/{LlamaCppBrowserManager,LlamaCppBrowserModelImport,LlamaCppBrowserHuggingFaceManager,LlamaCppBrowserDefaultModelAction}.vue`; `src/features/transformers-js/components/TransformersJsManager.vue`; `src/logic/endpoint-build-availability.ts` |
| `BrowserProvidedSettingsStep.vue` | `src/components/SettingsModal.vue`, `src/components/ConnectionTab.vue`; `src/features/prompt-api/components/PromptApiStatus.vue`, `src/features/prompt-api/runtime.ts` |
| `ChromeModelFlow.vue` | `src/features/prompt-api/{api,provider,runtime}.ts`, `src/features/prompt-api/provider.test.ts`; browser-managed model preparation and streamed chat answer |
| `SettingsInheritanceStep.vue` | `src/components/SettingsModal.vue`, `src/components/ConnectionTab.vue`, `src/components/ChatGroupSettingsPanel.vue`, `src/components/ChatSettingsPanel.vue`, `src/components/ModelSelector.vue`; `src/logic/chat-settings-resolver.ts` |
| `SettingsInheritanceDiagram.vue` | `src/logic/chat-settings-resolver.ts`, `src/logic/chat-settings-resolver.test.ts`; conceptual model lookup from Chat to group to Global for one question |
| `StorageSettingsStep.vue` | `src/components/SettingsModal.vue`, `src/components/StorageTab.vue`; `src/00-storage/service/index.ts`, `src/composables/useStoragePersistence.ts` |
| `BackupSettingsStep.vue` | `src/components/StorageTab.vue`, `src/features/import-export/components/ImportExportModal.vue`, `src/features/import-export/service.ts` |
| `CompactStep.vue` | `src/components/ChatPaneHeader.vue`, `ContextCompactMenuItem.vue`, `ContextCompactSettingsDialog.vue`, `ContextCompactProgressStrip.vue`; `src/composables/chat/chat-scoped/chat-compact-flow.ts`; `src/logic/context-compact.ts` and its tests |
| `GroupStep.vue` | `src/components/Sidebar.vue`, `ChatPaneHeader.vue`, `ChatGroupActions.vue`; `src/components/Sidebar.test.ts`, `Sidebar.dnd.test.ts`; `src/composables/chat/useChatGroups.ts` |
| `GroupSettingsStep.vue` | `src/components/Sidebar.vue`, `ChatGroupSettingsPanel.vue`, `SystemPromptSettingsEditor.vue`, `ModelSelector.vue`; `src/logic/chat-settings-resolver.ts` and its tests |
| `ImageCreationStep.vue` | `src/components/SidebarDebugControls.vue`; `src/features/image-generation/components/{ImageGenerationLab,ImageGenerationWorkspace,ImageGenerationEditor,ImageGenerationMonitor,ImageGenerationGallery,ImageGenerationAssetViewer}.vue`; `src/features/stable-diffusion-cpp-browser/components/{ImageModelLibrary,ImageModelCatalog}.vue`; `src/pages/image-generation.sessions.test.ts` |
| `AudioCreationStep.vue` | `src/components/SidebarDebugControls.vue`; `src/features/audio-generation/{AudioGenerationView.vue,README.md,AudioGenerationView.test.ts,model-catalog.ts}`; `src/features/audio-generation/components/AudioHistoryResult.vue` |
| `SuperEditStep.vue` | `src/components/ChatPaneHeader.vue`, `src/components/HistoryManipulationModal.vue`, `src/composables/chat/chat-scoped/chat-history-flow.ts`; `src/components/HistoryManipulationModal.test.ts` |
| `NaidanRpcStep.vue` | `src/features/naidan-rpc-integration/components/{NaidanRpcFeatureRow,NaidanRpcTab,RpcPeerProvision}.vue`; `src/features/naidan-rpc-integration/runtime/connection-permits.ts`; `src/components/ConnectionTab.vue`; `src/features/image-generation/components/ImageInferenceLocation.vue` |

`AppPermissionsDiagram.vue` explains general operating-system and browser access
rather than replicating a Naidan control. Its article links the relevant primary
references: Microsoft access tokens and process enumeration, Android app
sandbox, sensors and permissions, the HTML file input standard, browser file
system and Fetch APIs, and Chrome Direct Sockets.
The Wikipedia guide’s inline request-flow diagram follows
`src/features/privacy-fetch/{README.md,broker-client.ts,broker-entry.ts,client-standalone.ts}`
and the Wikipedia URL policy in `src/features/privacy-fetch/policies/wikipedia.ts`.

The chat chrome uses the application's gray-900/800 surfaces, gray-700 borders,
blue action color, logo and Lucide icons. Ordinary CSS replaces Tailwind because
Docs use their own compiler. Decorative icon buttons in static examples are not
focusable or presented as usable actions. The shared guide and language menus,
theme selector, motion pause control, search and browser-AI availability islands,
and branching island provide the actual Docs interactions.

## Motion policy

Motion is enabled initially and illustrates a specific operation. Streamed chat
content accumulates in reading order. A replay may reset the complete scene
together; do not erase individual messages from the bottom upward. Keep the
scene’s compact document footprint stable throughout an animation. A settings
scene may place an app-sized UI canvas inside a fixed-height camera viewport
and pan or zoom it with transforms. It may intentionally crop surrounding UI
while the current instruction, active label, control, and result remain readable.
Do not scale an entire settings screen down to fit the viewport or accidentally
cut off the focus content. Pause and reduced motion should show the completed
focus state for that step. Use pauses where repeated movement helps explain an
operation. The shared
`data-docs-animation` contract allows the global CSS pause
control and reduced-motion preference to stop it. All explanatory content remains
in the surrounding prose; no instruction requires tracking a moving object.
Update static, reduced-motion and narrow-layout checks when changing a diagram.

A demonstration is not a captured running session. Guide captions can explain
the operation where useful; the homepage does not need a disclaimer caption.
Maintain fidelity by inspecting source and behavior tests. Do not add screenshot
capture to the build or require a capture workflow before updating a replica.
