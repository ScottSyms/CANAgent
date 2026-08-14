// Advanced agent configuration for the workspace Models page — the Behavior,
// Generation, Search & embeddings, and Connected-services groups that used to
// live in the sidebar SettingsScreen's Advanced tab (that overlay is gone; the
// workspace is now the one place to configure the extension beyond first-run
// onboarding).
//
// Persistence is PATCH-style on purpose: several workspace sections edit the
// same ba_settings object (ModelSection above this one, and this section), so
// saving re-reads storage and overwrites only the fields this section owns.
// A whole-object write from a component's possibly-stale copy would silently
// revert whatever another section saved after this one mounted.

import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_LOCAL_EMBED_MODEL, type Settings } from '../shared/types';
import { useT } from '../sidebar/i18n';
import { Group, Toggle } from './SettingsControls';

const EMPTY: Settings = { baseUrl: '', apiKey: '', model: '' };

/** The ba_settings fields this section owns (see the patch-save note above). */
function ownFields(s: Settings): Partial<Settings> {
  return {
    retryOnRateLimit: s.retryOnRateLimit ?? true,
    verifyAnswers: s.verifyAnswers ?? true,
    summarizeObservations: s.summarizeObservations ?? true,
    maxSteps: s.maxSteps,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    systemPrompt: s.systemPrompt?.trim() || undefined,
    embedder: s.embedder === 'external' ? 'external' : 'local',
    hybridSearch: s.hybridSearch ?? true,
    graphAssistedSearch: s.graphAssistedSearch ?? true,
    localEmbedModel: s.localEmbedModel?.trim() || undefined,
    embeddingModel: s.embeddingModel?.trim() || undefined,
    repoSearchK: s.repoSearchK,
    embeddingBaseUrl: s.embeddingBaseUrl?.trim().replace(/\/+$/, '') || undefined,
    embeddingApiKey: s.embeddingApiKey?.trim() || undefined,
    transcriptionModel: s.transcriptionModel?.trim() || undefined,
    transcriptionBaseUrl: s.transcriptionBaseUrl?.trim().replace(/\/+$/, '') || undefined,
    transcriptionApiKey: s.transcriptionApiKey?.trim() || undefined,
    sharepointBaseUrl: s.sharepointBaseUrl?.trim().replace(/\/+$/, '') || undefined,
    graphClientId: s.graphClientId?.trim() || undefined,
    graphTenant: s.graphTenant?.trim() || undefined,
  };
}

export function AdvancedSettingsSection() {
  const t = useT();
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get('ba_settings').then((r) => {
      if (r.ba_settings) setSettings(r.ba_settings as Settings);
    });
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
  };

  const save = async () => {
    const r = await chrome.storage.local.get('ba_settings');
    const current = (r.ba_settings as Settings | undefined) ?? EMPTY;
    await chrome.storage.local.set({ ba_settings: { ...current, ...ownFields(settings) } });
    setSaved(true);
  };

  return (
    <div class="ws-advanced-settings" data-testid="advanced-settings">
      <h2>{t('settings.tabAdvanced')}</h2>

      <Group title={t('settings.groupBehavior')} desc={t('settings.groupBehaviorDesc')}>
        <Toggle
          checked={settings.retryOnRateLimit ?? true}
          onChange={(checked) => update({ retryOnRateLimit: checked })}
          label={t('settings.retryOnRateLimit')}
          note={t('settings.retryOnRateLimitNote')}
        />
        <Toggle
          checked={settings.verifyAnswers ?? true}
          onChange={(checked) => update({ verifyAnswers: checked })}
          label={t('settings.verifyAnswers')}
          note={t('settings.verifyAnswersNote')}
        />
        <Toggle
          checked={settings.summarizeObservations ?? true}
          onChange={(checked) => update({ summarizeObservations: checked })}
          label={t('settings.summarizeObservations')}
          note={t('settings.summarizeObservationsNote')}
        />
        <label class="field">
          <span>{t('settings.maxSteps')}</span>
          <input
            type="number"
            min="1"
            max="1000"
            placeholder="20"
            value={settings.maxSteps ?? ''}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              update({ maxSteps: v === '' ? undefined : Number(v) });
            }}
          />
          <span class="field-note">{t('settings.maxStepsNote')}</span>
        </label>
      </Group>

      <Group title={t('settings.groupGeneration')} desc={t('settings.groupGenerationDesc')}>
        <div class="field-row">
          <label class="field">
            <span>{t('settings.temperature')}</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={settings.temperature ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ temperature: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
          <label class="field">
            <span>{t('settings.maxTokens')}</span>
            <input
              type="number"
              min="1"
              value={settings.maxTokens ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ maxTokens: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
        </div>
        <label class="field">
          <span>{t('settings.customInstructions')}</span>
          <textarea
            class="chat-input"
            rows={5}
            placeholder={t('settings.customInstructionsPlaceholder')}
            value={settings.systemPrompt ?? ''}
            onInput={(e) => update({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
          />
        </label>
      </Group>

      <Group title={t('settings.groupRetrieval')} desc={t('settings.groupRetrievalDesc')}>
        <label class="field">
          <span>{t('settings.embedder')}</span>
          <select
            value={settings.embedder ?? 'local'}
            onChange={(e) => update({ embedder: (e.target as HTMLSelectElement).value as 'local' | 'external' })}
          >
            <option value="local">{t('settings.embedder.local')}</option>
            <option value="external">{t('settings.embedder.external')}</option>
          </select>
          <span class="field-note">{t('settings.embedder.note')}</span>
        </label>

        <Toggle
          checked={settings.hybridSearch ?? true}
          onChange={(checked) => update({ hybridSearch: checked })}
          label={t('settings.hybridSearch')}
          note={t('settings.hybridSearchNote')}
        />

        <Toggle
          checked={settings.graphAssistedSearch ?? true}
          onChange={(checked) => update({ graphAssistedSearch: checked })}
          label={t('settings.graphAssistedSearch')}
          note={t('settings.graphAssistedSearchNote')}
        />

        <div class="field-row">
          <label class="field">
            <span>{t('settings.embeddingModel')}</span>
            <input
              type="text"
              disabled={settings.embedder !== 'external'}
              placeholder={settings.embedder === 'external' ? 'text-embedding-3-small' : DEFAULT_LOCAL_EMBED_MODEL}
              value={
                settings.embedder === 'external'
                  ? (settings.embeddingModel ?? '')
                  : (settings.localEmbedModel ?? DEFAULT_LOCAL_EMBED_MODEL)
              }
              onInput={(e) => update({ embeddingModel: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.repoSearchK')}</span>
            <input
              type="number"
              min="1"
              placeholder="6"
              value={settings.repoSearchK ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ repoSearchK: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
        </div>
        <p class="settings-note">{t('settings.repoSearchKNote')}</p>

        <div class="field-row">
          <label class="field">
            <span>{t('settings.embeddingUrl')}</span>
            <input
              type="url"
              placeholder="https://embeddings.example.com/v1"
              value={settings.embeddingBaseUrl ?? ''}
              onInput={(e) => update({ embeddingBaseUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.embeddingKey')}</span>
            <input
              type="password"
              placeholder="sk-…"
              value={settings.embeddingApiKey ?? ''}
              onInput={(e) => update({ embeddingApiKey: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
      </Group>

      <Group title={t('settings.groupIntegrations')} desc={t('settings.groupIntegrationsDesc')}>
        <label class="field">
          <span>{t('settings.transcriptionModel')}</span>
          <input
            type="text"
            placeholder="whisper-1"
            value={settings.transcriptionModel ?? ''}
            onInput={(e) => update({ transcriptionModel: (e.target as HTMLInputElement).value })}
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span>{t('settings.transcriptionUrl')}</span>
            <input
              type="url"
              placeholder="https://stt.example.com/v1"
              value={settings.transcriptionBaseUrl ?? ''}
              onInput={(e) => update({ transcriptionBaseUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.transcriptionKey')}</span>
            <input
              type="password"
              placeholder="sk-…"
              value={settings.transcriptionApiKey ?? ''}
              onInput={(e) => update({ transcriptionApiKey: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>

        <label class="field">
          <span>{t('settings.sharepointUrl')}</span>
          <input
            type="url"
            placeholder="https://contoso.sharepoint.com"
            value={settings.sharepointBaseUrl ?? ''}
            onInput={(e) => update({ sharepointBaseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span>{t('settings.graphClientId')}</span>
            <input
              type="text"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={settings.graphClientId ?? ''}
              onInput={(e) => update({ graphClientId: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.graphTenant')}</span>
            <input
              type="text"
              placeholder="organizations"
              value={settings.graphTenant ?? ''}
              onInput={(e) => update({ graphTenant: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
        <p class="settings-note">{t('settings.graphNote')}</p>
      </Group>

      {saved && <div class="banner banner-ok">{t('settings.saved')}</div>}
      <div class="settings-actions">
        <button class="btn btn-primary" onClick={save}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
