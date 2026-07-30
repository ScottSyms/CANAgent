import { useState } from 'preact/hooks';
import type { ExportedProduct, ExportedRepo } from '../shared/messages';
import type { ConversationSummary } from '../shared/types';
import { saveFile } from './download';
import { useT } from './i18n';

// chrome.storage.local keys that make up the user's configuration.
const STORAGE_KEYS = ['ba_settings', 'ba_sites', 'ba_capabilities', 'ba_skills', 'ba_memory', 'ba_memory_graph', 'ba_lessons', 'ba_memory_enabled', 'ba_memory_min_confidence', 'ba_language', 'ba_projects', 'ba_active_project'];
const CONVERSATION_INDEX_KEY = 'ba_conv_index';
const CONVERSATION_KEY_PREFIX = 'ba_conv_';
const CONVERSATION_LABELS_KEY = 'ba_conv_labels';

/**
 * Gather the conversation index, the label registry, and every conversation body
 * for an opt-in export. Labels travel with conversations (they reference them by id).
 */
async function collectConversationStorage(): Promise<Record<string, unknown>> {
  const idx = (await chrome.storage.local.get(CONVERSATION_INDEX_KEY))[CONVERSATION_INDEX_KEY];
  const index = Array.isArray(idx) ? (idx as ConversationSummary[]) : [];
  const keys = [
    CONVERSATION_INDEX_KEY,
    CONVERSATION_LABELS_KEY,
    ...index.map((c) => `${CONVERSATION_KEY_PREFIX}${c.id}`),
  ];
  return (await chrome.storage.local.get(keys)) as Record<string, unknown>;
}

interface Backup {
  // Current exports tag 'CANChat Agent'; legacy files tagged 'CANAgent' still restore.
  app: 'CANChat Agent' | 'CANAgent';
  kind: 'backup';
  version: number;
  exportedAt: string;
  storage: Record<string, unknown>;
  repos: ExportedRepo[];
  products: ExportedProduct[];
}

export function BackupRestoreSection({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Default to EXCLUDING the API key from exports (technical-debt.md §6.1): a
  // backup should not carry a bearer secret in plaintext unless deliberately opted in.
  const [includeKey, setIncludeKey] = useState(false);
  const [includeConversations, setIncludeConversations] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const exportAll = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const storage = (await chrome.storage.local.get(STORAGE_KEYS)) as Record<string, unknown>;
      if (includeConversations) {
        Object.assign(storage, await collectConversationStorage());
      }
      if (!includeKey && storage.ba_settings && typeof storage.ba_settings === 'object') {
        // Strip the main key and the optional per-service override keys.
        storage.ba_settings = {
          ...(storage.ba_settings as object),
          apiKey: '',
          embeddingApiKey: '',
          transcriptionApiKey: '',
        };
      }
      if (!includeKey && Array.isArray(storage.ba_sites)) {
        // MCP server tokens live in the hints directory — scrub them too.
        storage.ba_sites = (storage.ba_sites as Array<Record<string, unknown>>).map((s) =>
          s && s.mcpToken ? { ...s, mcpToken: '' } : s,
        );
      }
      const repos = (await chrome.runtime.sendMessage({ type: 'repo_export' })) as ExportedRepo[];
      const products = (await chrome.runtime.sendMessage({ type: 'products_export' })) as ExportedProduct[];
      const backup: Backup = {
        app: 'CANChat Agent',
        kind: 'backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        storage,
        repos: Array.isArray(repos) ? repos : [],
        products: Array.isArray(products) ? products : [],
      };
      saveFile(
        new Blob([JSON.stringify(backup)], { type: 'application/json' }),
        `canchat-agent-backup-${new Date().toISOString().slice(0, 10)}.json`,
      );
      const n = backup.repos.length;
      const p = backup.products.length;
      const extras = [
        n ? `${n} repositor${n === 1 ? 'y' : 'ies'}` : '',
        p ? `${p} product${p === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      const extraText = extras.length ? `, and ${extras.join(' and ')}` : '';
      setMessage({
        ok: true,
        text: `Exported settings, hints, skills, memory${extraText}.`,
      });
    } catch (e) {
      setMessage({ ok: false, text: `Export failed: ${String(e)}` });
    }
    setBusy(false);
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const data = JSON.parse(await file.text()) as Partial<Backup>;
      if ((data?.app !== 'CANChat Agent' && data?.app !== 'CANAgent') || data?.kind !== 'backup') {
        throw new Error('Not a CANChat Agent backup file.');
      }
      const ok = window.confirm(
        'Restore will overwrite your current settings, hints, skills, and memory, and replace any repositories or products with the same name/id. Continue?',
      );
      if (!ok) {
        setBusy(false);
        return;
      }
      if (data.storage && typeof data.storage === 'object') {
        await chrome.storage.local.set(data.storage);
      }
      if (Array.isArray(data.repos) && data.repos.length) {
        await chrome.runtime.sendMessage({ type: 'repo_import', repos: data.repos });
      }
      if (Array.isArray(data.products) && data.products.length) {
        await chrome.runtime.sendMessage({ type: 'products_import', products: data.products });
      }
      setMessage({ ok: true, text: 'Restore complete. Reloading…' });
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      setMessage({ ok: false, text: `Restore failed: ${String(e)}` });
    }
    setBusy(false);
  };

  return (
    <details class="sites-section settings-acc" open={defaultOpen}>
      <summary class="settings-header settings-acc-summary">
        <strong>Backup &amp; Restore</strong>
      </summary>
      <p class="settings-note">
        Export your configuration — endpoint settings, hints, skills, memory, on-device
        repositories, and generated products — to a single JSON file, and restore it on this or
        another device.
      </p>
      <label class="backup-check">
        <input
          type="checkbox"
          checked={includeKey}
          onChange={(e) => setIncludeKey((e.target as HTMLInputElement).checked)}
        />
        Include API key in the backup
      </label>
      {includeKey && (
        <p class="settings-note warn">⚠ The file will contain your API key in plain text — store it securely.</p>
      )}
      <label class="backup-check">
        <input
          type="checkbox"
          checked={includeConversations}
          onChange={(e) => setIncludeConversations((e.target as HTMLInputElement).checked)}
        />
        {t('backup.includeConversations')}
      </label>
      {includeConversations && <p class="settings-note warn">⚠ {t('backup.includeConversationsNote')}</p>}
      <div class="settings-actions">
        <button class="btn" disabled={busy} onClick={exportAll}>
          Export backup
        </button>
        <label class={`btn ${busy ? 'btn-disabled' : ''}`}>
          Restore from file…
          <input
            type="file"
            accept="application/json,.json"
            style="display:none"
            disabled={busy}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              if (f) void importFile(f);
              input.value = '';
            }}
          />
        </label>
      </div>
      {message && <div class={`banner ${message.ok ? 'banner-ok' : 'banner-error'}`}>{message.text}</div>}
    </details>
  );
}
