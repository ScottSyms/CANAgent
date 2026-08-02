// =============================================================================
// In-app localization (English / French) for the side-panel UI.
//
// We use a small dictionary + a stored preference rather than chrome.i18n,
// because chrome.i18n follows the browser UI language and can't be switched
// in-app at runtime — and the requirement is a user-selectable EN/FR toggle.
//
// The preference lives in chrome.storage.local under `ba_language`
// ('auto' | 'en' | 'fr'); 'auto' resolves to the browser language. Components
// read the translator via `useT()` and re-render live when the toggle changes.
//
// Translation note: the French here is a DRAFT for review by a qualified
// translator before official Government of Canada use (see docs/TRAINING.md).
// Keys are grouped by screen to make that review a single-file pass.
// =============================================================================

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

export type Lang = 'en' | 'fr';
export type LangPref = 'auto' | Lang;

export const LANGUAGE_STORAGE_KEY = 'ba_language';

type Dict = Record<string, string>;

const EN: Dict = {
  // common
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.dismiss': 'Dismiss',
  // projects
  'projects.switcher': 'Active project',
  'projects.none': 'No project',
  // header
  'header.history': 'Conversation history',
  'header.saveConversation': 'Save conversation as HTML',
  'header.newChat': 'New chat (this one stays in History)',
  'header.newChatShort': 'New Chat',
  'header.undo': 'Undo last exchange (puts your message back to edit)',
  'header.learnStart': 'Start learn mode',
  'header.learnStop': 'Stop learn mode',
  'header.learnBanner': 'Learn mode is recording interactions on this site.',
  'header.settings': 'Settings',
  'header.knowledge': 'Knowledge Base',
  'header.more': 'More actions',
  'header.undoShort': 'Undo last exchange',
  'header.smallerText': 'Smaller text',
  'header.resetText': 'Reset text size',
  'header.largerText': 'Larger text',
  'header.noModel': 'No model configured.',
  'header.openSettings': 'Open settings',
  // errors
  'error.retry': 'Retry',
  'error.checkKey': 'Check your API key in Settings.',
  'error.checkEndpoint': 'Check the endpoint URL in Settings.',
  'error.checkModel': 'Check the model name in Settings.',
  'error.rateLimited':
    'The model endpoint is rate-limiting requests. It kept retrying, but the endpoint is still over capacity — try again shortly.',
  // chat
  'chat.empty':
    'Ask about the current page, your open tabs, or anything on the web — the agent will use the browser when it needs to. Type @ to insert a bookmark, # to reference a knowledge base.',
  'chat.help': 'Help & tips',
  'chat.placeholder': 'Ask the agent… (@ bookmarks, # knowledge bases)',
  'chat.placeholderDisabled': 'Configure a model in Settings first',
  'chat.send': 'Send',
  'chat.pause': 'Pause',
  'chat.stop': 'Stop',
  'chat.copy': '⧉ Copy',
  'chat.copied': '✓ Copied',
  // approval card
  'approval.title': 'Approve action?',
  'approval.tech': 'Technical detail',
  'approval.allow': 'Allow for this session',
  'approval.approve': 'Approve',
  'approval.deny': 'Deny',
  // plan + tool activity panels
  'plan.title': 'Plan',
  'activity.title': 'Tool activity',
  // download / export cards
  'export.download': 'Download',
  'export.csv': 'Download CSV',
  'export.json': 'Download JSON',
  'export.copyCsv': 'Copy CSV',
  // save-as-skill chip
  'distill.offer': 'Save this workflow as a reusable skill?',
  'distill.save': 'Save skill',
  // skills manager chrome
  'skillsUi.title': 'Skills',
  'skillsUi.desc': 'Reusable procedures for the agent. Skills can auto-trigger from the task, load from a site, or be launched with /name in chat.',
  'skillsUi.search': 'Search skills',
  'skillsUi.add': 'Add skill',
  'skillsUi.importUrl': 'Import from URL',
  'skillsUi.importJson': 'Import JSON',
  'skillsUi.exportJson': 'Export JSON',
  'skillsUi.importZip': 'Import zip',
  'skillsUi.library': 'App playbook library',
  // memory workspace page chrome
  'memoryPage.search': 'Search memories…',
  'memoryPage.select': 'Select a memory to view or edit it.',
  'memoryPage.active': 'Active',
  'memoryPage.stale': 'Stale',
  'memoryPage.superseded': 'Superseded',
  'memoryPage.allStatuses': 'All statuses',
  'memoryPage.allKinds': 'All kinds',
  'memoryPage.entity': 'Entity',
  'memoryPage.fact': 'Fact',
  'memoryPage.preference': 'Preference',
  'memoryPage.event': 'Event',
  // runtime notices (background reads ba_language and translates)
  'notice.busyRetry': '⏳ The model endpoint is busy (HTTP {status}). Waiting {secs}s, then retrying (attempt {attempt})…',
  // context toolbar (page capture)
  'context.screenshot': 'Screenshot',
  'context.screenshotHint':
    'Capture the visible part of the current tab as an image for the model — for content text extraction can’t see (dashboards, canvases, PDFs).',
  'context.capturePage': 'Capture full page',
  'context.capturePageHint':
    'Capture the WHOLE page by scrolling top to bottom — images the model can read (opaque/long pages).',
  'context.refresh': 'Refresh',
  'context.knowledgeBase': 'Knowledge base name',
  'context.clear': 'Clear',
  'context.addTab': 'Add tab',
  'context.addTabHint': 'Save this tab’s text into the named on-device knowledge base.',
  'context.addGroup': 'Add group',
  'context.addGroupHint': 'Save every page in this conversation’s tab group into the named knowledge base.',
  'context.stale': 'stale',
  // repositories (knowledge bases)
  'repos.title': 'Knowledge bases',
  'repos.note':
    'On-device document stores the agent can search. It fills them when you add pages, and answers from them on demand. Stored only on this device.',
  'repos.loading': 'Loading…',
  'repos.empty': 'No knowledge bases yet.',
  'repos.docs': 'docs',
  'repos.chunks': 'chunks',
  'repos.showDocs': 'Show documents',
  'repos.hideDocs': 'Hide documents',
  'repos.deleteRepo': 'Delete knowledge base',
  'repos.deleteDoc': 'Delete this document',
  'repos.noDocs': 'No documents.',
  'repos.upload.add': 'Add files',
  'repos.upload.attach': 'Attach files',
  'repos.upload.done': 'Added {n} file(s) to “{repo}”.',
  'repos.upload.cancel': 'Cancel',
  'repos.folder.working': 'Indexing…',
  'repos.folder.dropTitle': '📁 Drag a folder here to index it',
  'repos.folder.dropHint':
    'Drag a folder from Finder/Explorer onto this box. Its files (and subfolders) are embedded on-device and kept searchable. Drag the same folder again to re-index only what changed.',
  'repos.folder.emptyDrop': 'No supported files found in that folder.',
  'repos.folder.scanning': 'Scanning folder…',
  'repos.folder.indexing': 'Indexing {file}…',
  'repos.folder.synced': 'Indexed: {added} added, {updated} updated, {skipped} unchanged, {removed} removed, {failed} failed.',
  'repos.folder.unreadableHint':
    '{n} file(s) couldn’t be read — likely OneDrive/SharePoint online-only files. In Explorer/Finder, right-click them and choose “Always keep on this device” (or open them once to download), then drag the folder again.',
  'repos.folder.refresh': 'Refresh from folder',
  'repos.folder.error': 'Folder indexing failed: {msg}',
  'mail.title': '📧 Index my Office 365 mailbox',
  'mail.hint': 'Indexes your mail on-device over a Microsoft Graph connection. Re-run to add only new messages.',
  'mail.index': 'Index my Outlook mailbox',
  'mail.connect': 'Connect & index',
  'mail.disconnect': 'Disconnect',
  'mail.working': '📧 Indexing mailbox…',
  'mail.starting': 'Reading your mailbox…',
  'mail.indexing': 'Indexing ({n}): {subject}…',
  'mail.done': 'Mailbox indexed: {added} added, {skipped} unchanged, {failed} failed.',
  'mail.error': 'Mailbox indexing failed: {msg}',
  'mail.needClientId': 'Set your Azure app Client ID in Settings → Advanced first (see the note there for required scopes).',
  'mail.autoRefresh': 'Auto-refresh hourly',
  'mail.autoRefreshNote':
    'Keeps the mailbox current in the background over your existing Outlook session — no need to click Index again. Off by default; only refreshes a mailbox you’ve indexed at least once.',
  'mail.autoRefreshLast': 'Last auto-refresh: {when} — {added} new message(s).',
  'mail.autoRefreshLastError': 'Last auto-refresh failed ({when}): {msg}',
  'memory.title': 'Memory',
  'memory.toggle': 'Remember things about me (stored only on this device)',
  'memory.note':
    'When enabled, the agent extracts durable facts about you from your conversations — your role, projects, interests, and preferences — and uses them to tailor answers. You can also say "remember that…" or "forget…".',
  'memory.manage': 'Manage memories',
  'memory.minConfidence': 'Only auto-save facts the agent is at least this confident about',
  'memory.minConfidenceNote':
    'Raise this to make automatic saving more conservative. Does not affect things you explicitly ask it to remember.',
  'sharepoint.title': '☁ Index SharePoint / OneDrive documents',
  'sharepoint.hint': 'Indexes a SharePoint or OneDrive document library over your existing browser sign-in. Re-run to add only changed files.',
  'sharepoint.libraryUrl': 'Library URL',
  'sharepoint.repo': 'Knowledge base',
  'sharepoint.repoPlaceholder': 'e.g. team documents',
  'sharepoint.index': 'Index library',
  'sharepoint.working': '☁ Indexing SharePoint…',
  'sharepoint.starting': 'Reading SharePoint documents…',
  'sharepoint.indexing': 'Indexing ({n}): {file}…',
  'sharepoint.done': 'SharePoint indexed: {added} added, {skipped} unchanged, {failed} failed.',
  'sharepoint.error': 'SharePoint indexing failed: {msg}',
  'sharepoint.needUrl': 'Enter a SharePoint or OneDrive library URL first.',
  'repos.upload.target': 'Add to',
  'repos.upload.newRepo': 'New knowledge base…',
  'repos.upload.newName': 'Name',
  'repos.upload.newNamePlaceholder': 'e.g. policies',
  'repos.upload.dropHint': 'Drop or paste (⌘/Ctrl+V) files or an email, or click to choose',
  'repos.upload.types': 'PDF · Word · PowerPoint · Excel · text · email',
  'repos.upload.note':
    'Files are parsed on-device, then chunked and embedded via your model endpoint (each chunk is sent to the embeddings service). Max 20 MB per file.',
  'repos.upload.needName': 'Enter a name for the new knowledge base first.',
  'repos.upload.nothing': 'Nothing to add from that drop.',
  'repos.upload.emailBadge': 'Email',
  'repos.upload.working': 'Adding…',
  'repos.upload.queued': 'queued',
  'repos.dropOverlay.title': 'Drop to add to a knowledge base',
  'repos.dropOverlay.note': 'A file, or an email dragged/pasted from Mail or Outlook',
  'repos.dropUnreadable': "Couldn't read a file or email from that. It offered:",
  'repos.upload.addedOne': 'added ({c})',
  'repos.upload.skippedOne': 'skipped — {why}',
  // status
  'status.idle': 'Idle',
  'status.thinking': 'Thinking…',
  'status.acting': 'Browsing…',
  'status.paused': 'Paused',
  'status.awaiting_approval': 'Waiting for approval',
  'status.auth_required': 'Login required',
  'status.error': 'Error',
  // settings — language
  'settings.language': 'Language',
  'settings.languageNote': 'Interface language. “Auto” follows your browser.',
  'settings.languageAuto': 'Auto',
  'settings.languageEn': 'English',
  'settings.languageFr': 'Français',
  // settings — model config
  'settings.title': 'Settings',
  'settings.tabModel': 'Model',
  'settings.tabAdvanced': 'Advanced',
  'settings.help': 'Help & docs',
  // settings — group headings (Mac-style grouped cards)
  'settings.groupConnection': 'Model connection',
  'settings.groupInterface': 'Interface',
  'settings.groupImage': 'Image generation',
  'settings.groupImageDesc': 'Optional Ideogram settings used only by the create_image tool.',
  'settings.groupBehavior': 'Agent behaviour',
  'settings.groupBehaviorDesc': 'How the agent works through a task.',
  'settings.groupGeneration': 'Generation',
  'settings.groupGenerationDesc': 'Model output controls. Leave blank for the endpoint’s defaults.',
  'settings.groupRetrieval': 'Search & embeddings',
  'settings.groupRetrievalDesc': 'How knowledge bases index and retrieve your saved pages.',
  'settings.groupIntegrations': 'Connected services',
  'settings.groupIntegrationsDesc': 'Optional endpoints: Azure OpenAI, voice transcription, SharePoint, Microsoft 365.',
  // automations
  'automations.title': 'Automations',
  'automations.note': 'Background work the agent does without you watching.',
  'automations.scheduledTasks': 'Scheduled tasks',
  'automations.scheduledTasksNote': 'Set tasks to run later or on a cadence.',
  'automations.noneYet': 'None yet — ask the agent to schedule a task and it will appear here.',
  'automations.recentRuns': 'Recent runs',
  'automations.workflows': 'Workflows',
  'automations.workflowsNote': 'A named, ordered chain of existing skills.',
  'automations.workflowName': 'Name',
  'automations.workflowDescription': 'Description (optional)',
  'automations.workflowSkills': 'Skills, in order (comma-separated /names)',
  'automations.workflowSkillsKnown': 'Known: {skills}',
  'automations.workflowSkillsNone': 'none saved yet',
  'automations.createWorkflow': 'Create workflow',
  'automations.updateWorkflow': 'Update workflow',
  'automations.addWorkflow': 'Add workflow',
  'automations.eventTriggers': 'Event triggers',
  'automations.eventTriggersNote': 'Run a skill or workflow unattended the next time you open a matching site.',
  'automations.triggerName': 'Name',
  'automations.triggerSite': 'Site (hostname, subdomains included)',
  'automations.triggerRun': 'Run',
  'automations.triggerSkill': 'A skill',
  'automations.triggerWorkflow': 'A workflow',
  'automations.chooseSkill': 'Choose a skill…',
  'automations.chooseWorkflow': 'Choose a workflow…',
  'automations.cooldownMinutes': 'Cooldown minutes (optional, default 60)',
  'automations.fireEveryPage': 'Fire on every page in this site',
  'automations.fireEveryPageNote': 'Ignore cooldown when the URL changes within the same host.',
  'automations.createTrigger': 'Create trigger',
  'automations.updateTrigger': 'Update trigger',
  'automations.addTrigger': 'Add trigger',
  'automations.enabled': 'enabled',
  'automations.paused': 'paused',
  'automations.allPages': 'all pages',
  'automations.cooldown': 'cooldown',
  'automations.edit': 'Edit',
  'automations.delete': 'Delete',
  'automations.pause': 'Pause',
  'automations.resume': 'Resume',
  'automations.next': 'Next',
  'automations.last': 'Last',
  'automations.deletedWorkflow': '(deleted workflow)',
  'automations.deletedTrigger': '(deleted trigger)',
  'automations.savedToProducts': 'Saved to Products',
  // Products (workspace console)
  'products.title': 'Products',
  'products.note':
    'Files generated by scheduled tasks and event triggers (e.g. a PowerPoint or Word doc from an unattended run) — saved here on-device rather than forced into an OS download for every job. Download or delete them any time; nothing here expires on its own.',
  'products.emptyTitle': 'Nothing yet.',
  'products.emptyHint': 'A file generated during a scheduled task or event trigger run will appear here.',
  'products.download': 'Download',
  'products.from': 'from “{title}”',
  'products.loadFailed': 'Could not load “{filename}” — it may have been removed.',
  // model profiles
  'modelProfiles.title': 'Model profiles & routing',
  'modelProfiles.note': 'Route background work to a different (often cheaper or local) model than the main chat loop.',
  'modelProfiles.utilityRole': 'Utility',
  'modelProfiles.utilityHint': 'Titles/summaries, self-check, RAG paraphrase/rerank, skill distillation',
  'modelProfiles.reflectionRole': 'Reflection',
  'modelProfiles.reflectionHint': 'Lesson-learning, memory extraction and merge decisions',
  'modelProfiles.planRole': 'Plan',
  'modelProfiles.planHint': 'Scoped multi-step research subtasks',
  'modelProfiles.visionRole': 'Vision',
  'modelProfiles.visionHint': 'Attached images & page-screenshot OCR',
  'modelProfiles.name': 'Name',
  'modelProfiles.description': 'Description',
  'modelProfiles.endpointUrl': 'Endpoint base URL',
  'modelProfiles.apiKey': 'API key',
  'modelProfiles.model': 'Model',
  'modelProfiles.temperature': 'Temperature (optional)',
  'modelProfiles.maxTokens': 'Max tokens (optional)',
  'modelProfiles.privacyTier': 'Privacy tier',
  'modelProfiles.cloud': 'Cloud (hosted service)',
  'modelProfiles.local': 'Local (on-device / private network)',
  'modelProfiles.capabilities': 'Capabilities',
  'modelProfiles.vision': 'Vision',
  'modelProfiles.audio': 'Audio',
  'modelProfiles.video': 'Video',
  'modelProfiles.tagLocalNote': 'Tag a profile Local only if it is actually private.',
  'modelProfiles.roleAssignment': 'Role assignment',
  'modelProfiles.sameAsMain': 'Same as main model',
  'modelProfiles.restrictLocal': 'Restrict background tasks to local-tagged profiles',
  'modelProfiles.restrictLocalNote': 'Any role routed to a profile not tagged Local falls back to the main model.',
  'modelProfiles.roleCapabilityMissing': 'This profile does not declare {capability} support.',
  'modelProfiles.addProfile': 'Add profile',
  'modelProfiles.updateProfile': 'Update profile',
  'modelProfiles.edit': 'Edit',
  'modelProfiles.delete': 'Delete',
  // workspace console — nav
  'workspace.nav.chat': 'Chat',
  'workspace.nav.projects': 'Projects',
  'workspace.nav.knowledge': 'Knowledge',
  'workspace.nav.memory': 'Memory',
  'workspace.nav.automations': 'Automations',
  'workspace.nav.products': 'Products',
  'workspace.nav.skills': 'Skills',
  'workspace.nav.tools': 'Tools',
  'workspace.nav.models': 'Models',
  'workspace.nav.data': 'Data',
  'workspace.nav.image': 'Image',
  'workspace.nav.settings': 'Settings',
  'onboarding.title': 'Welcome to CANChat Agent',
  'onboarding.intro':
    'An AI agent that uses your browser as its tools — ask about the current page, your open tabs, or the web. To begin, connect a model. The key is stored only on this device and never synced.',
  'onboarding.start': 'Save & start',
  'onboarding.advanced': 'Advanced setup…',
  'settings.note':
    'Connect any OpenAI-compatible endpoint (remote API, local model, or gateway). The key is stored only on this device and never synced.',
  'settings.endpointUrl': 'Endpoint base URL',
  'settings.apiKey': 'API key',
  'settings.model': 'Model',
  'settings.ideogramApiKey': 'Ideogram API key (optional)',
  'settings.apiVersion': 'Azure API version (optional)',
  'settings.apiVersionNote':
    'Set this only for Azure OpenAI (e.g. 2024-02-01). When filled, requests use Azure’s api-version query parameter and api-key header. Your endpoint URL should point at the deployment, e.g. https://NAME.openai.azure.com/openai/deployments/DEPLOYMENT',
  'settings.retryOnRateLimit': 'Auto-retry when the endpoint is rate-limited',
  'settings.retryOnRateLimitNote':
    'When the model endpoint is busy (HTTP 429 or a temporary server error), wait and retry automatically instead of failing — honoring the server’s Retry-After hint. Recommended for capacity-limited endpoints like Azure OpenAI.',
  'settings.verifyAnswers': 'Self-check answers before finishing',
  'settings.verifyAnswersNote':
    'Run one quick review pass over a finished answer and let the agent fix it if it looks incomplete or unverified. Improves reliability at the cost of one extra model call per task. Turn off to accept the first answer.',
  'settings.summarizeObservations': 'Summarize old results when compacting',
  'settings.summarizeObservationsNote':
    'On a long task, condense older tool results with a quick model call (keeping key facts and links) instead of dropping them. Turn off to skip the extra call and just trim them.',
  'settings.temperature': 'Temperature (optional)',
  'settings.maxTokens': 'Max tokens (optional)',
  'settings.embedder': 'Embeddings',
  'settings.embedder.local': 'On-device (transformers.js)',
  'settings.embedder.external': 'External /embeddings endpoint',
  'settings.embedder.note':
    'On-device keeps RAG fully local (model downloads once, then runs on the machine). External sends chunk text to your /embeddings endpoint. Switching embedders requires re-indexing existing knowledge bases.',
  'settings.hybridSearch': 'Hybrid search (semantic + keyword)',
  'settings.hybridSearchNote':
    'Blend semantic (meaning) and keyword (BM25) ranking so exact tokens — IDs, codes, names — surface alongside related passages. Off = pure semantic. No re-indexing needed either way.',
  'settings.embeddingModel':
    'Embedding model (optional) — for local repositories; defaults to the model above if blank',
  'settings.repoSearchK': 'Passages per repository search',
  'settings.repoSearchKNote':
    'How many passages each repository search returns. Default 6 — higher finds more but uses more context.',
  'settings.maxSteps': 'Maximum steps per task',
  'settings.maxStepsNote':
    'Tool-iteration budget per task. Default 20 — raise it for long jobs like deep pagination; it can extend to twice this when a plan is unfinished. Higher allows more work but costs more.',
  'settings.embeddingUrl': 'Embedding endpoint base URL (optional) — blank uses the main endpoint above',
  'settings.embeddingKey': 'Embedding API key (optional) — blank uses the main key',
  'settings.transcriptionModel':
    'Transcription model (optional) — enables voice prompts (mic button); must be a speech-to-text model your endpoint exposes at /audio/transcriptions',
  'settings.transcriptionUrl':
    'Transcription endpoint base URL (optional) — blank uses the main endpoint above',
  'settings.transcriptionKey': 'Transcription API key (optional) — blank uses the main key',
  'settings.sharepointUrl':
    'SharePoint base URL (optional) — enables search over your SharePoint via the signed-in session; blank = auto-detect from an open SharePoint tab',
  'settings.graphClientId': 'Azure app Client ID (for mail, calendar, and drafts)',
  'settings.graphTenant': 'Azure tenant (optional — default: organizations)',
  'settings.graphNote':
    'Mail search, calendar_search, draft_email, and mailbox indexing all use Microsoft Graph (OAuth). Register an Azure AD app with redirect URI matching this extension\'s chrome.identity redirect, requesting delegated scopes Mail.Read, Mail.ReadWrite (needed even just to create a draft), Calendars.Read, offline_access, openid — most enterprise tenants require admin consent for these. SharePoint/OneDrive file search does not need this; it uses your existing browser session.',
  'settings.customInstructions':
    "Custom instructions (optional) — appended to the agent's built-in instructions; applies from your next message",
  'settings.customInstructionsPlaceholder':
    'e.g. Answer in French.\nI work in geospatial data — prefer technical depth over simplification.',
  'settings.saved': 'Settings saved.',
  'settings.testing': 'Testing…',
  'settings.testConnection': 'Test connection',
  'settings.playbookIndexUrl': 'App playbook library URL',
  'settings.playbookIndexUrlNote':
    'Where the Skills panel’s “App playbook library” looks for installable skills — a JSON index listing SKILL.md files. Leave blank to use the built-in default.',
  'settings.playbookIndexUrlReset': 'Reset to default',
  // History overlay
  'conversations.title': 'Conversation history',
  'conversations.empty': 'No saved conversations yet. Conversations are saved automatically as you chat.',
  'conversations.untitled': 'Untitled conversation',
  'conversations.continue': 'Continue',
  'conversations.save': 'Save',
  'conversations.export': 'Export',
  'conversations.delete': 'Delete',
  'conversations.load': 'Load from file…',
  'conversations.clearAll': 'Clear all',
  'conversations.confirmDelete': 'Delete “{title}”? This cannot be undone.',
  'conversations.confirmClearAll': 'Delete all {n} saved conversations? This cannot be undone.',
  'conversations.importError': 'That file isn’t a CANChat Agent conversation.',
  'conversations.messageCount': '{n} messages',
  'conversations.labels': 'Labels',
  'conversations.noMatches': 'No conversations match the selected labels.',
  'conversations.assignLabels': 'Labels',
  'conversations.labelNamePlaceholder': 'Label name',
  'conversations.addLabel': 'Add',
  'conversations.renameLabel': 'Rename',
  'conversations.deleteLabel': 'Delete label',
  'conversations.confirmDeleteLabel': 'Delete the label “{name}”? It will be removed from every conversation.',
  'conversations.clearFilter': 'Clear',
  'conversations.noLabels': 'No labels yet. Create one below.',
  'conversations.search': 'Search conversations…',
  'conversations.sortRecent': 'Newest first',
  'conversations.sortOldest': 'Oldest first',
  'conversations.noSearchMatches': 'No conversations match your search.',
  // Backup & Restore
  'backup.includeConversations': 'Include saved conversations',
  'backup.includeConversationsNote':
    'Conversations can contain page content and screenshots. Off by default — only export them if you intend to.',
};

const FR: Dict = {
  // common
  'common.cancel': 'Annuler',
  'common.save': 'Enregistrer',
  'common.delete': 'Supprimer',
  'common.dismiss': 'Ignorer',
  // projects
  'projects.switcher': 'Projet actif',
  'projects.none': 'Aucun projet',
  // header
  'header.history': 'Historique des conversations',
  'header.saveConversation': 'Enregistrer la conversation en HTML',
  'header.newChat': 'Nouvelle conversation (celle-ci reste dans l’historique)',
  'header.newChatShort': 'Nouvelle conversation',
  'header.undo': 'Annuler le dernier échange (remet votre message à modifier)',
  'header.learnStart': 'Démarrer le mode d’apprentissage',
  'header.learnStop': 'Arrêter le mode d’apprentissage',
  'header.learnBanner': 'Le mode d’apprentissage enregistre les interactions sur ce site.',
  'header.settings': 'Paramètres',
  'header.knowledge': 'Base de connaissances',
  'header.more': 'Plus d’actions',
  'header.undoShort': 'Annuler le dernier échange',
  'header.smallerText': 'Texte plus petit',
  'header.resetText': 'Réinitialiser la taille du texte',
  'header.largerText': 'Texte plus grand',
  'header.noModel': 'Aucun modèle configuré.',
  'header.openSettings': 'Ouvrir les paramètres',
  // errors
  'error.retry': 'Réessayer',
  'error.checkKey': 'Vérifiez votre clé d’API dans les paramètres.',
  'error.checkEndpoint': 'Vérifiez l’URL du point de terminaison dans les paramètres.',
  'error.checkModel': 'Vérifiez le nom du modèle dans les paramètres.',
  'error.rateLimited':
    'Le point de terminaison limite le débit des requêtes. Les tentatives ont été répétées, mais il est toujours surchargé — réessayez sous peu.',
  // chat
  'chat.empty':
    'Posez des questions sur la page actuelle, vos onglets ouverts ou le Web — l’agent utilisera le navigateur au besoin. Tapez @ pour insérer un signet, # pour référencer une base de connaissances.',
  'chat.help': 'Aide et astuces',
  'chat.placeholder': 'Demandez à l’agent… (@ signets, # bases de connaissances)',
  'chat.placeholderDisabled': 'Configurez d’abord un modèle dans les paramètres',
  'chat.send': 'Envoyer',
  'chat.pause': 'Pause',
  'chat.stop': 'Arrêter',
  'chat.copy': '⧉ Copier',
  'chat.copied': '✓ Copié',
  // carte d’approbation
  'approval.title': 'Approuver l’action?',
  'approval.tech': 'Détail technique',
  'approval.allow': 'Autoriser pour cette session',
  'approval.approve': 'Approuver',
  'approval.deny': 'Refuser',
  // panneaux plan + activité
  'plan.title': 'Plan',
  'activity.title': 'Activité des outils',
  // cartes de téléchargement / export
  'export.download': 'Télécharger',
  'export.csv': 'Télécharger CSV',
  'export.json': 'Télécharger JSON',
  'export.copyCsv': 'Copier CSV',
  // puce « enregistrer comme compétence »
  'distill.offer': 'Enregistrer ce flux comme compétence réutilisable?',
  'distill.save': 'Enregistrer',
  // gestionnaire de compétences
  'skillsUi.title': 'Compétences',
  'skillsUi.desc': 'Procédures réutilisables pour l’agent. Elles peuvent se déclencher automatiquement, se charger depuis un site, ou être lancées avec /nom dans la discussion.',
  'skillsUi.search': 'Rechercher des compétences',
  'skillsUi.add': 'Ajouter une compétence',
  'skillsUi.importUrl': 'Importer depuis une URL',
  'skillsUi.importJson': 'Importer JSON',
  'skillsUi.exportJson': 'Exporter JSON',
  'skillsUi.importZip': 'Importer un zip',
  'skillsUi.library': 'Bibliothèque de guides d’applications',
  // page Mémoire (espace de travail)
  'memoryPage.search': 'Rechercher des souvenirs…',
  'memoryPage.select': 'Sélectionnez un souvenir pour le consulter ou le modifier.',
  'memoryPage.active': 'Actifs',
  'memoryPage.stale': 'Périmés',
  'memoryPage.superseded': 'Remplacés',
  'memoryPage.allStatuses': 'Tous les états',
  'memoryPage.allKinds': 'Tous les types',
  'memoryPage.entity': 'Entité',
  'memoryPage.fact': 'Fait',
  'memoryPage.preference': 'Préférence',
  'memoryPage.event': 'Événement',
  // avis d’exécution (l’arrière-plan lit ba_language et traduit)
  'notice.busyRetry': '⏳ Le point de terminaison est occupé (HTTP {status}). Attente de {secs} s, puis nouvel essai (tentative {attempt})…',
  // context toolbar (page capture)
  'context.screenshot': 'Capture d’écran',
  'context.screenshotHint':
    'Capture la partie visible de l’onglet actuel comme image pour le modèle — pour le contenu que l’extraction de texte ne voit pas (tableaux de bord, canevas, PDF).',
  'context.capturePage': 'Capturer la page entière',
  'context.capturePageHint':
    'Capture TOUTE la page en défilant de haut en bas — des images que le modèle peut lire (pages opaques/longues).',
  'context.refresh': 'Actualiser',
  'context.knowledgeBase': 'Nom de la base de connaissances',
  'context.clear': 'Effacer',
  'context.addTab': 'Ajouter l’onglet',
  'context.addTabHint': 'Enregistre le texte de cet onglet dans la base de connaissances nommée (sur l’appareil).',
  'context.addGroup': 'Ajouter le groupe',
  'context.addGroupHint':
    'Enregistre chaque page du groupe d’onglets de cette conversation dans la base nommée.',
  'context.stale': 'périmé',
  // repositories (knowledge bases)
  'repos.title': 'Bases de connaissances',
  'repos.note':
    'Stockages de documents sur l’appareil que l’agent peut interroger. Elles se remplissent lorsque vous ajoutez des pages, et l’agent y répond à la demande. Stockées uniquement sur cet appareil.',
  'repos.loading': 'Chargement…',
  'repos.empty': 'Aucune base de connaissances pour l’instant.',
  'repos.docs': 'docs',
  'repos.chunks': 'segments',
  'repos.showDocs': 'Afficher les documents',
  'repos.hideDocs': 'Masquer les documents',
  'repos.deleteRepo': 'Supprimer la base de connaissances',
  'repos.deleteDoc': 'Supprimer ce document',
  'repos.noDocs': 'Aucun document.',
  'repos.upload.add': 'Ajouter des fichiers',
  'repos.upload.attach': 'Joindre des fichiers',
  'repos.upload.done': '{n} fichier(s) ajouté(s) à « {repo} ».',
  'repos.folder.working': 'Indexation…',
  'repos.folder.dropTitle': '📁 Glissez un dossier ici pour l’indexer',
  'repos.folder.dropHint':
    'Glissez un dossier depuis le Finder/Explorateur sur cette zone. Ses fichiers (et sous-dossiers) sont vectorisés sur l’appareil et restent interrogeables. Re-glissez le même dossier pour ne réindexer que ce qui a changé.',
  'repos.folder.emptyDrop': 'Aucun fichier pris en charge dans ce dossier.',
  'repos.folder.scanning': 'Analyse du dossier…',
  'repos.folder.indexing': 'Indexation de {file}…',
  'repos.folder.synced': 'Indexé : {added} ajoutés, {updated} mis à jour, {skipped} inchangés, {removed} supprimés, {failed} échoués.',
  'repos.folder.unreadableHint':
    '{n} fichier(s) illisibles — probablement des fichiers OneDrive/SharePoint « en ligne seulement ». Dans l’Explorateur/Finder, faites un clic droit et choisissez « Toujours conserver sur cet appareil » (ou ouvrez-les une fois pour les télécharger), puis glissez le dossier de nouveau.',
  'repos.folder.refresh': 'Actualiser depuis le dossier',
  'repos.folder.error': 'Échec de l’indexation du dossier : {msg}',
  'mail.title': '📧 Indexer ma boîte Office 365',
  'mail.hint': 'Indexe vos courriels sur l’appareil via une connexion Microsoft Graph. Relancez pour n’ajouter que les nouveaux messages.',
  'mail.index': 'Indexer ma boîte Outlook',
  'mail.connect': 'Connecter et indexer',
  'mail.disconnect': 'Déconnecter',
  'mail.working': '📧 Indexation de la boîte…',
  'mail.starting': 'Lecture de votre boîte…',
  'mail.indexing': 'Indexation ({n}) : {subject}…',
  'mail.done': 'Boîte indexée : {added} ajoutés, {skipped} inchangés, {failed} échoués.',
  'mail.error': 'Échec de l’indexation de la boîte : {msg}',
  'mail.needClientId': 'Configurez d’abord le Client ID de votre application Azure dans Paramètres → Avancé (voir la note pour les autorisations requises).',
  'mail.autoRefresh': 'Actualisation automatique (toutes les heures)',
  'mail.autoRefreshNote':
    'Garde la boîte à jour en arrière-plan avec votre session Outlook existante — plus besoin de cliquer sur Indexer. Désactivé par défaut; n’actualise qu’une boîte déjà indexée au moins une fois.',
  'mail.autoRefreshLast': 'Dernière actualisation automatique : {when} — {added} nouveau(x) message(s).',
  'mail.autoRefreshLastError': 'Échec de la dernière actualisation automatique ({when}) : {msg}',
  'memory.title': 'Mémoire',
  'memory.toggle': 'Se souvenir de moi (stocké uniquement sur cet appareil)',
  'memory.note':
    'Lorsqu’activée, l’agent extrait des faits durables vous concernant à partir de vos conversations — votre rôle, vos projets, vos intérêts et vos préférences — et les utilise pour adapter ses réponses. Vous pouvez aussi dire « souviens-toi que… » ou « oublie… ».',
  'memory.manage': 'Gérer les souvenirs',
  'memory.minConfidence': 'Enregistrer automatiquement seulement les faits dont l’agent est au moins aussi confiant',
  'memory.minConfidenceNote':
    'Augmentez cette valeur pour rendre l’enregistrement automatique plus prudent. N’affecte pas ce que vous demandez explicitement de retenir.',
  'sharepoint.title': '☁ Indexer les documents SharePoint / OneDrive',
  'sharepoint.hint': 'Indexe une bibliothèque SharePoint ou OneDrive avec votre session navigateur existante. Relancez pour n’ajouter que les fichiers modifiés.',
  'sharepoint.libraryUrl': 'URL de la bibliothèque',
  'sharepoint.repo': 'Base de connaissances',
  'sharepoint.repoPlaceholder': 'p. ex. documents équipe',
  'sharepoint.index': 'Indexer la bibliothèque',
  'sharepoint.working': '☁ Indexation SharePoint…',
  'sharepoint.starting': 'Lecture des documents SharePoint…',
  'sharepoint.indexing': 'Indexation ({n}) : {file}…',
  'sharepoint.done': 'SharePoint indexé : {added} ajoutés, {skipped} inchangés, {failed} échoués.',
  'sharepoint.error': 'Échec de l’indexation SharePoint : {msg}',
  'sharepoint.needUrl': 'Entrez d’abord une URL de bibliothèque SharePoint ou OneDrive.',
  'repos.upload.cancel': 'Annuler',
  'repos.upload.target': 'Ajouter à',
  'repos.upload.newRepo': 'Nouvelle base de connaissances…',
  'repos.upload.newName': 'Nom',
  'repos.upload.newNamePlaceholder': 'p. ex. politiques',
  'repos.upload.dropHint': 'Déposez ou collez (⌘/Ctrl+V) des fichiers ou un courriel, ou cliquez pour choisir',
  'repos.upload.types': 'PDF · Word · PowerPoint · Excel · texte · courriel',
  'repos.upload.note':
    'Les fichiers sont analysés sur l’appareil, puis segmentés et vectorisés via votre point de terminaison (chaque segment est envoyé au service d’intégration). Max 20 Mo par fichier.',
  'repos.upload.needName': 'Saisissez d’abord un nom pour la nouvelle base de connaissances.',
  'repos.upload.nothing': 'Rien à ajouter depuis ce dépôt.',
  'repos.upload.emailBadge': 'Courriel',
  'repos.upload.working': 'Ajout…',
  'repos.upload.queued': 'en attente',
  'repos.dropOverlay.title': 'Déposez pour ajouter à une base de connaissances',
  'repos.dropOverlay.note': 'Un fichier, ou un courriel glissé/collé depuis Mail ou Outlook',
  'repos.dropUnreadable': "Impossible de lire un fichier ou un courriel. Types proposés :",
  'repos.upload.addedOne': 'ajouté ({c})',
  'repos.upload.skippedOne': 'ignoré — {why}',
  // status
  'status.idle': 'Inactif',
  'status.thinking': 'Réflexion…',
  'status.acting': 'Navigation…',
  'status.paused': 'En pause',
  'status.awaiting_approval': 'En attente d’approbation',
  'status.auth_required': 'Connexion requise',
  'status.error': 'Erreur',
  // settings — language
  'settings.language': 'Langue',
  'settings.languageNote': 'Langue de l’interface. « Auto » suit votre navigateur.',
  'settings.languageAuto': 'Auto',
  'settings.languageEn': 'English',
  'settings.languageFr': 'Français',
  // settings — model config
  'settings.title': 'Paramètres',
  'settings.tabModel': 'Modèle',
  'settings.tabAdvanced': 'Avancé',
  'settings.help': 'Aide et docs',
  // settings — group headings (Mac-style grouped cards)
  'settings.groupConnection': 'Connexion au modèle',
  'settings.groupInterface': 'Interface',
  'settings.groupImage': 'Génération d’images',
  'settings.groupImageDesc': 'Paramètres Ideogram optionnels utilisés uniquement par l’outil create_image.',
  'settings.groupBehavior': 'Comportement de l’agent',
  'settings.groupBehaviorDesc': 'Comment l’agent mène une tâche.',
  'settings.groupGeneration': 'Génération',
  'settings.groupGenerationDesc': 'Réglages de sortie du modèle. Laissez vide pour les valeurs par défaut.',
  'settings.groupRetrieval': 'Recherche et vectorisation',
  'settings.groupRetrievalDesc': 'Comment les bases de connaissances indexent et retrouvent vos pages.',
  'settings.groupIntegrations': 'Services connectés',
  'settings.groupIntegrationsDesc': 'Points d’accès optionnels : Azure OpenAI, transcription vocale, SharePoint, Microsoft 365.',
  // automations
  'automations.title': 'Automatisations',
  'automations.note': 'Travail en arrière-plan que l’agent effectue sans que vous regardiez.',
  'automations.scheduledTasks': 'Tâches planifiées',
  'automations.scheduledTasksNote': 'Planifiez des tâches pour plus tard ou à intervalle régulier.',
  'automations.noneYet': 'Rien pour l’instant — demandez à l’agent de planifier une tâche.',
  'automations.recentRuns': 'Exécutions récentes',
  'automations.workflows': 'Flux de travail',
  'automations.workflowsNote': 'Une chaîne ordonnée et nommée de compétences existantes.',
  'automations.workflowName': 'Nom',
  'automations.workflowDescription': 'Description (facultatif)',
  'automations.workflowSkills': 'Compétences, dans l’ordre ( /names séparés par des virgules)',
  'automations.workflowSkillsKnown': 'Connues : {skills}',
  'automations.workflowSkillsNone': 'aucune enregistrée pour le moment',
  'automations.createWorkflow': 'Créer le flux',
  'automations.updateWorkflow': 'Mettre à jour le flux',
  'automations.addWorkflow': 'Ajouter un flux',
  'automations.eventTriggers': 'Déclencheurs d’événements',
  'automations.eventTriggersNote': 'Exécutez une compétence ou un flux sans surveillance lors de l’ouverture d’un site correspondant.',
  'automations.triggerName': 'Nom',
  'automations.triggerSite': 'Site (hôte, sous-domaines inclus)',
  'automations.triggerRun': 'Exécuter',
  'automations.triggerSkill': 'Une compétence',
  'automations.triggerWorkflow': 'Un flux de travail',
  'automations.chooseSkill': 'Choisir une compétence…',
  'automations.chooseWorkflow': 'Choisir un flux…',
  'automations.cooldownMinutes': 'Minutes de refroidissement (facultatif, 60 par défaut)',
  'automations.fireEveryPage': 'Déclencher sur chaque page de ce site',
  'automations.fireEveryPageNote': 'Ignorer le refroidissement lorsque l’URL change dans le même hôte.',
  'automations.createTrigger': 'Créer le déclencheur',
  'automations.updateTrigger': 'Mettre à jour le déclencheur',
  'automations.addTrigger': 'Ajouter un déclencheur',
  'automations.enabled': 'activé',
  'automations.paused': 'en pause',
  'automations.allPages': 'toutes les pages',
  'automations.cooldown': 'refroidissement',
  'automations.edit': 'Modifier',
  'automations.delete': 'Supprimer',
  'automations.pause': 'Suspendre',
  'automations.resume': 'Reprendre',
  'automations.next': 'Prochaine',
  'automations.last': 'Dernière',
  'automations.deletedWorkflow': '(flux supprimé)',
  'automations.deletedTrigger': '(déclencheur supprimé)',
  'automations.savedToProducts': 'Enregistré dans Produits',
  // Produits (console de l’espace de travail)
  'products.title': 'Produits',
  'products.note':
    'Fichiers générés par les tâches planifiées et les déclencheurs (p. ex. un PowerPoint ou un document Word issu d’une exécution non supervisée) — conservés ici sur l’appareil plutôt que téléchargés d’office à chaque tâche. Téléchargez-les ou supprimez-les à tout moment; rien n’expire de soi-même.',
  'products.emptyTitle': 'Rien pour l’instant.',
  'products.emptyHint': 'Un fichier généré lors d’une tâche planifiée ou d’un déclencheur apparaîtra ici.',
  'products.download': 'Télécharger',
  'products.from': 'de « {title} »',
  'products.loadFailed': 'Impossible de charger « {filename} » — il a peut-être été supprimé.',
  // model profiles
  'modelProfiles.title': 'Profils de modèle et routage',
  'modelProfiles.note': 'Acheminez le travail de fond vers un modèle différent (souvent moins coûteux ou local) que la conversation principale.',
  'modelProfiles.utilityRole': 'Utilitaire',
  'modelProfiles.utilityHint': 'Titres/résumés, auto-vérification, paraphrase/rerank RAG, distillation de compétence',
  'modelProfiles.reflectionRole': 'Réflexion',
  'modelProfiles.reflectionHint': 'Apprentissage de leçons, extraction de mémoire et décisions de fusion',
  'modelProfiles.planRole': 'Plan',
  'modelProfiles.planHint': 'Sous-tâches de recherche multi-étapes ciblées',
  'modelProfiles.visionRole': 'Vision',
  'modelProfiles.visionHint': 'Images jointes et OCR des captures d’écran',
  'modelProfiles.name': 'Nom',
  'modelProfiles.description': 'Description',
  'modelProfiles.endpointUrl': 'URL de base du point de terminaison',
  'modelProfiles.apiKey': 'Clé d’API',
  'modelProfiles.model': 'Modèle',
  'modelProfiles.temperature': 'Température (facultatif)',
  'modelProfiles.maxTokens': 'Jetons maximum (facultatif)',
  'modelProfiles.privacyTier': 'Niveau de confidentialité',
  'modelProfiles.cloud': 'Nuage (service hébergé)',
  'modelProfiles.local': 'Local (sur l’appareil / réseau privé)',
  'modelProfiles.capabilities': 'Capacités',
  'modelProfiles.vision': 'Vision',
  'modelProfiles.audio': 'Audio',
  'modelProfiles.video': 'Vidéo',
  'modelProfiles.tagLocalNote': 'N’étiquetez Local que si le profil est réellement privé.',
  'modelProfiles.roleAssignment': 'Assignation des rôles',
  'modelProfiles.sameAsMain': 'Identique au modèle principal',
  'modelProfiles.restrictLocal': 'Restreindre les tâches d’arrière-plan aux profils marqués Local',
  'modelProfiles.restrictLocalNote': 'Tout rôle associé à un profil non Local revient au modèle principal.',
  'modelProfiles.roleCapabilityMissing': 'Ce profil ne déclare pas la prise en charge de {capability}.',
  'modelProfiles.addProfile': 'Ajouter un profil',
  'modelProfiles.updateProfile': 'Mettre à jour le profil',
  'modelProfiles.edit': 'Modifier',
  'modelProfiles.delete': 'Supprimer',
  // workspace console — nav
  'workspace.nav.chat': 'Discussion',
  'workspace.nav.projects': 'Projets',
  'workspace.nav.knowledge': 'Connaissances',
  'workspace.nav.memory': 'Mémoire',
  'workspace.nav.automations': 'Automatisations',
  'workspace.nav.products': 'Produits',
  'workspace.nav.skills': 'Compétences',
  'workspace.nav.tools': 'Outils',
  'workspace.nav.models': 'Modèles',
  'workspace.nav.data': 'Données',
  'workspace.nav.image': 'Image',
  'workspace.nav.settings': 'Paramètres',
  'onboarding.title': 'Bienvenue dans CANChat Agent',
  'onboarding.intro':
    'Un agent IA qui utilise votre navigateur comme outils — posez des questions sur la page actuelle, vos onglets ouverts ou le Web. Pour commencer, connectez un modèle. La clé est stockée uniquement sur cet appareil et n’est jamais synchronisée.',
  'onboarding.start': 'Enregistrer et démarrer',
  'onboarding.advanced': 'Configuration avancée…',
  'settings.note':
    'Connectez n’importe quel point de terminaison compatible avec OpenAI (API distante, modèle local ou passerelle). La clé est stockée uniquement sur cet appareil et n’est jamais synchronisée.',
  'settings.endpointUrl': 'URL de base du point de terminaison',
  'settings.apiKey': 'Clé d’API',
  'settings.model': 'Modèle',
  'settings.ideogramApiKey': 'Clé d’API Ideogram (facultatif)',
  'settings.apiVersion': 'Version d’API Azure (facultatif)',
  'settings.apiVersionNote':
    'À remplir uniquement pour Azure OpenAI (p. ex. 2024-02-01). Si renseigné, les requêtes utilisent le paramètre api-version et l’en-tête api-key d’Azure. L’URL du point de terminaison doit viser le déploiement, p. ex. https://NOM.openai.azure.com/openai/deployments/DEPLOIEMENT',
  'settings.retryOnRateLimit': 'Réessayer automatiquement en cas de limitation du débit',
  'settings.retryOnRateLimitNote':
    'Lorsque le point de terminaison est occupé (HTTP 429 ou erreur serveur temporaire), patienter et réessayer automatiquement au lieu d’échouer — en respectant l’indication Retry-After du serveur. Recommandé pour les points de terminaison à capacité limitée comme Azure OpenAI.',
  'settings.verifyAnswers': 'Vérifier la réponse avant de conclure',
  'settings.verifyAnswersNote':
    'Effectuer une rapide passe de révision sur une réponse terminée et laisser l’agent la corriger si elle paraît incomplète ou non vérifiée. Améliore la fiabilité au prix d’un appel de modèle supplémentaire par tâche. Désactiver pour accepter la première réponse.',
  'settings.summarizeObservations': 'Résumer les anciens résultats lors du compactage',
  'settings.summarizeObservationsNote':
    'Sur une tâche longue, condenser les anciens résultats d’outils par un rapide appel de modèle (en conservant les faits et liens clés) au lieu de les supprimer. Désactiver pour éviter l’appel supplémentaire et simplement les tronquer.',
  'settings.temperature': 'Température (facultatif)',
  'settings.maxTokens': 'Jetons maximum (facultatif)',
  'settings.embedder': 'Vectorisation',
  'settings.embedder.local': 'Sur l’appareil (transformers.js)',
  'settings.embedder.external': 'Point de terminaison /embeddings externe',
  'settings.embedder.note':
    'Sur l’appareil garde le RAG entièrement local (le modèle se télécharge une fois, puis s’exécute localement). Externe envoie le texte des segments à votre point de terminaison /embeddings. Changer de moteur exige de réindexer les bases existantes.',
  'settings.hybridSearch': 'Recherche hybride (sémantique + mots-clés)',
  'settings.hybridSearchNote':
    'Combine le classement sémantique (sens) et par mots-clés (BM25) pour que les jetons exacts — identifiants, codes, noms — ressortent à côté des passages liés. Désactivé = purement sémantique. Aucune réindexation requise.',
  'settings.embeddingModel':
    'Modèle d’intégration (facultatif) — pour les dépôts locaux; utilise le modèle ci-dessus si vide',
  'settings.repoSearchK': 'Passages par recherche de dépôt',
  'settings.repoSearchKNote':
    'Nombre de passages renvoyés par chaque recherche de dépôt. Par défaut 6 — plus élevé trouve davantage mais consomme plus de contexte.',
  'settings.maxSteps': 'Nombre maximal d’étapes par tâche',
  'settings.maxStepsNote':
    'Budget d’itérations d’outils par tâche. Par défaut 20 — augmentez-le pour les tâches longues comme la pagination approfondie; il peut atteindre le double lorsqu’un plan est inachevé. Plus élevé permet plus de travail mais coûte davantage.',
  'settings.embeddingUrl':
    'URL de base du point de terminaison d’intégration (facultatif) — vide = point de terminaison principal ci-dessus',
  'settings.embeddingKey': 'Clé d’API d’intégration (facultatif) — vide = clé principale',
  'settings.transcriptionModel':
    'Modèle de transcription (facultatif) — active les invites vocales (bouton micro); doit être un modèle de reconnaissance vocale exposé par votre point de terminaison à /audio/transcriptions',
  'settings.transcriptionUrl':
    'URL de base du point de terminaison de transcription (facultatif) — vide = point de terminaison principal ci-dessus',
  'settings.transcriptionKey': 'Clé d’API de transcription (facultatif) — vide = clé principale',
  'settings.sharepointUrl':
    'URL de base SharePoint (facultatif) — active la recherche dans votre SharePoint via la session ouverte; vide = détection automatique à partir d’un onglet SharePoint ouvert',
  'settings.graphClientId': 'Client ID de l’application Azure (courriels, calendrier et brouillons)',
  'settings.graphTenant': 'Locataire Azure (facultatif — défaut : organizations)',
  'settings.graphNote':
    'La recherche de courriels, calendar_search, draft_email et l’indexation de la boîte utilisent tous Microsoft Graph (OAuth). Inscrivez une application Azure AD avec un URI de redirection correspondant à celui de chrome.identity pour cette extension, en demandant les autorisations déléguées Mail.Read, Mail.ReadWrite (requis même pour créer un brouillon), Calendars.Read, offline_access, openid — la plupart des locataires d’entreprise exigent le consentement de l’administrateur. La recherche SharePoint/OneDrive n’en a pas besoin; elle utilise votre session de navigateur existante.',
  'settings.customInstructions':
    'Instructions personnalisées (facultatif) — ajoutées aux instructions intégrées de l’agent; s’appliquent dès votre prochain message',
  'settings.customInstructionsPlaceholder':
    'p. ex. Réponds en français.\nJe travaille en données géospatiales — privilégie la profondeur technique à la simplification.',
  'settings.saved': 'Paramètres enregistrés.',
  'settings.testing': 'Essai en cours…',
  'settings.testConnection': 'Tester la connexion',
  'settings.playbookIndexUrl': 'URL de la bibliothèque de guides d’applications',
  'settings.playbookIndexUrlNote':
    'Emplacement consulté par la « Bibliothèque de guides » du panneau Compétences pour les compétences installables — un index JSON listant des fichiers SKILL.md. Laissez vide pour utiliser la valeur par défaut intégrée.',
  'settings.playbookIndexUrlReset': 'Réinitialiser',
  // Historique
  'conversations.title': 'Historique des conversations',
  'conversations.empty':
    'Aucune conversation enregistrée pour l’instant. Les conversations sont enregistrées automatiquement au fil de l’échange.',
  'conversations.untitled': 'Conversation sans titre',
  'conversations.continue': 'Continuer',
  'conversations.save': 'Enregistrer',
  'conversations.export': 'Exporter',
  'conversations.delete': 'Supprimer',
  'conversations.load': 'Charger depuis un fichier…',
  'conversations.clearAll': 'Tout effacer',
  'conversations.confirmDelete': 'Supprimer « {title} »? Cette action est irréversible.',
  'conversations.confirmClearAll':
    'Supprimer les {n} conversations enregistrées? Cette action est irréversible.',
  'conversations.importError': 'Ce fichier n’est pas une conversation CANChat Agent.',
  'conversations.messageCount': '{n} messages',
  'conversations.labels': 'Étiquettes',
  'conversations.noMatches': 'Aucune conversation ne correspond aux étiquettes sélectionnées.',
  'conversations.assignLabels': 'Étiquettes',
  'conversations.labelNamePlaceholder': 'Nom de l’étiquette',
  'conversations.addLabel': 'Ajouter',
  'conversations.renameLabel': 'Renommer',
  'conversations.deleteLabel': 'Supprimer l’étiquette',
  'conversations.confirmDeleteLabel':
    'Supprimer l’étiquette « {name} »? Elle sera retirée de toutes les conversations.',
  'conversations.clearFilter': 'Effacer',
  'conversations.noLabels': 'Aucune étiquette pour l’instant. Créez-en une ci-dessous.',
  'conversations.search': 'Rechercher des conversations…',
  'conversations.sortRecent': 'Plus récentes d’abord',
  'conversations.sortOldest': 'Plus anciennes d’abord',
  'conversations.noSearchMatches': 'Aucune conversation ne correspond à votre recherche.',
  // Sauvegarde et restauration
  'backup.includeConversations': 'Inclure les conversations enregistrées',
  'backup.includeConversationsNote':
    'Les conversations peuvent contenir le contenu de pages et des captures d’écran. Désactivé par défaut — ne les exportez que si vous le souhaitez.',
};

export const MESSAGES: Record<Lang, Dict> = { en: EN, fr: FR };

/** Resolve a stored preference to a concrete language. */
export function resolveLang(pref: LangPref | undefined): Lang {
  if (pref === 'en' || pref === 'fr') return pref;
  try {
    return chrome.i18n.getUILanguage().toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** Look up a key, fall back to English then the raw key, and interpolate {name} params. */
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let s = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

const LangContext = createContext<{ lang: Lang; t: Translator }>({
  lang: 'en',
  t: (key) => key,
});

export function LanguageProvider({ children }: { children: ComponentChildren }) {
  // Seed from the browser language so an "auto" user sees no English flash;
  // storage (an explicit choice) resolves a tick later.
  const [lang, setLang] = useState<Lang>(() => resolveLang('auto'));
  useEffect(() => {
    const load = () =>
      chrome.storage.local
        .get(LANGUAGE_STORAGE_KEY)
        .then((r) => setLang(resolveLang(r[LANGUAGE_STORAGE_KEY] as LangPref | undefined)));
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LANGUAGE_STORAGE_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const t: Translator = (key, params) => translate(lang, key, params);
  return <LangContext.Provider value={{ lang, t }}>{children}</LangContext.Provider>;
}

export function useT(): Translator {
  return useContext(LangContext).t;
}

