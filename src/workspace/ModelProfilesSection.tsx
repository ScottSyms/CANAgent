import { useEffect, useState } from 'preact/hooks';
import type { ModelProfile, ModelProtocol, ModelRole, Settings } from '../shared/types';
import { useT } from '../sidebar/i18n';

const PROTOCOLS: Array<{ value: ModelProtocol; label: string }> = [
  { value: 'chat-completions', label: 'settings.protocolChatCompletions' },
  { value: 'responses', label: 'settings.protocolResponses' },
  { value: 'anthropic-messages', label: 'settings.protocolAnthropic' },
  { value: 'gemini-native', label: 'settings.protocolGemini' },
];

const ROLES: Array<{ role: Exclude<ModelRole, 'main'>; label: string; hint: string }> = [
  { role: 'utility', label: 'modelProfiles.utilityRole', hint: 'modelProfiles.utilityHint' },
  { role: 'reflection', label: 'modelProfiles.reflectionRole', hint: 'modelProfiles.reflectionHint' },
  { role: 'plan', label: 'modelProfiles.planRole', hint: 'modelProfiles.planHint' },
  { role: 'vision', label: 'modelProfiles.visionRole', hint: 'modelProfiles.visionHint' },
];

const EMPTY_FORM: Omit<ModelProfile, 'id'> = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  apiVersion: '',
  privacyTier: 'cloud',
  description: '',
  capabilities: {
    vision: false,
    audio: false,
    video: false,
  },
};

const ROLE_CAPABILITY: Partial<Record<Exclude<ModelRole, 'main'>, keyof NonNullable<ModelProfile['capabilities']>>> = {
  vision: 'vision',
};

function hasCapability(profile: ModelProfile | undefined, capability: keyof NonNullable<ModelProfile['capabilities']>): boolean {
  return Boolean(profile?.capabilities?.[capability]);
}

function selectedCapabilities(profile: ModelProfile): string[] {
  const caps = profile.capabilities;
  if (!caps) return [];
  return [
    caps.vision ? 'vision' : '',
    caps.audio ? 'audio' : '',
    caps.video ? 'video' : '',
  ].filter(Boolean);
}

function newId(): string {
  return `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_SETTINGS: Settings = { baseUrl: '', apiKey: '', model: '' };

async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get('ba_settings');
  return (r.ba_settings as Settings | undefined) ?? EMPTY_SETTINGS;
}

// A named alternate endpoint routed by role — the main chat model (Settings
// baseUrl/apiKey/model above) is never affected by anything here. Absent
// role mapping = that role just uses the main model, same as before profiles
// existed. See llmProvider.ts resolveModelForRole for the resolution logic.
export function ModelProfilesSection() {
  const t = useT();
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const profiles = settings.modelProfiles ?? [];

  const patch = async (next: Partial<Settings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    await chrome.storage.local.set({ ba_settings: merged });
  };

  const formValid = form.name.trim() && form.baseUrl.trim() && form.apiKey.trim() && form.model.trim();

  const submitForm = async () => {
    if (!formValid) return;
    const description = form.description?.trim() || undefined;
    const capabilities = form.capabilities && (form.capabilities.vision || form.capabilities.audio || form.capabilities.video)
      ? {
          vision: Boolean(form.capabilities.vision),
          audio: Boolean(form.capabilities.audio),
          video: Boolean(form.capabilities.video),
        }
      : undefined;
    const profile: ModelProfile = {
      id: editingId ?? newId(),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      model: form.model.trim(),
      apiVersion: form.apiVersion?.trim() || undefined,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      privacyTier: form.privacyTier,
      description,
      capabilities,
    };
    const next = editingId ? profiles.map((p) => (p.id === editingId ? profile : p)) : [...profiles, profile];
    await patch({ modelProfiles: next });
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const edit = (p: ModelProfile) => {
    setForm({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      apiVersion: p.apiVersion ?? '',
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      privacyTier: p.privacyTier ?? 'cloud',
      description: p.description ?? '',
      capabilities: {
        vision: p.capabilities?.vision ?? false,
        audio: p.capabilities?.audio ?? false,
        video: p.capabilities?.video ?? false,
      },
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    const nextRoles = { ...settings.roleProfiles };
    for (const key of Object.keys(nextRoles) as Array<keyof typeof nextRoles>) {
      if (nextRoles[key] === id) delete nextRoles[key];
    }
    await patch({ modelProfiles: profiles.filter((p) => p.id !== id), roleProfiles: nextRoles });
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setShowForm(false);
    }
  };

  const setRoleProfile = async (role: Exclude<ModelRole, 'main'>, profileId: string) => {
    const next = { ...settings.roleProfiles };
    if (profileId) next[role] = profileId;
    else delete next[role];
    await patch({ roleProfiles: next });
  };

  return (
    <div class="ws-model-profiles">
      <h2>{t('modelProfiles.title')}</h2>
      <p class="settings-note">{t('modelProfiles.note')}</p>

      {profiles.length > 0 && (
      <ul class="sites-list">
          {profiles.map((p) => (
            <li key={p.id} class="site-row">
              <div class="site-main">
                <div class="site-row-top">
                    <span class={`approval-tag trust-badge trust-${p.privacyTier === 'local' ? 'local' : 'public'}`}>
                      {p.privacyTier === 'local' ? t('modelProfiles.local') : t('modelProfiles.cloud')}
                    </span>
                    {selectedCapabilities(p).map((cap) => (
                      <span key={cap} class="approval-tag approval-cap">
                        {cap === 'vision' ? t('modelProfiles.vision') : cap === 'audio' ? t('modelProfiles.audio') : t('modelProfiles.video')}
                      </span>
                    ))}
                </div>
                <span class="site-name">{p.name}</span>
                <span class="site-desc">{p.model} — {p.baseUrl}</span>
                {p.description && <span class="site-note">{p.description}</span>}
              </div>
              <button class="icon-btn" title={t('modelProfiles.edit')} onClick={() => edit(p)}>✎</button>
              <button class="icon-btn" title={t('modelProfiles.delete')} onClick={() => remove(p.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <div class="site-form">
          <label class="field">
              <span>{t('modelProfiles.name')}</span>
              <input type="text" placeholder="Local Ollama" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span>{t('modelProfiles.description')}</span>
            <input
              type="text"
              placeholder="Cheap local model for summarization and utility work"
              value={form.description ?? ''}
              onInput={(e) => setForm({ ...form, description: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
              <span>{t('modelProfiles.endpointUrl')}</span>
            <input type="url" placeholder="http://localhost:11434/v1" value={form.baseUrl} onInput={(e) => setForm({ ...form, baseUrl: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
              <span>{t('modelProfiles.apiKey')}</span>
            <input type="password" placeholder="sk-… (blank if the endpoint needs none)" value={form.apiKey} onInput={(e) => setForm({ ...form, apiKey: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
              <span>{t('modelProfiles.model')}</span>
            <input type="text" placeholder="llama3" value={form.model} onInput={(e) => setForm({ ...form, model: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
              <span>{t('modelProfiles.protocol')}</span>
            <select
              value={form.protocol ?? 'chat-completions'}
              onChange={(e) => setForm({ ...form, protocol: (e.target as HTMLSelectElement).value as ModelProtocol })}
            >
              {PROTOCOLS.map((p) => (
                <option key={p.value} value={p.value}>
                  {t(p.label)}
                </option>
              ))}
            </select>
          </label>
          <div class="field-row">
            <label class="field">
              <span>{t('modelProfiles.temperature')}</span>
              <input
                type="number" step="0.1" min="0" max="2"
                value={form.temperature ?? ''}
                onInput={(e) => { const v = (e.target as HTMLInputElement).value; setForm({ ...form, temperature: v === '' ? undefined : Number(v) }); }}
              />
            </label>
            <label class="field">
              <span>{t('modelProfiles.maxTokens')}</span>
              <input
                type="number" min="1"
                value={form.maxTokens ?? ''}
                onInput={(e) => { const v = (e.target as HTMLInputElement).value; setForm({ ...form, maxTokens: v === '' ? undefined : Number(v) }); }}
              />
            </label>
          </div>
          <label class="field">
            <span>{t('modelProfiles.privacyTier')}</span>
            <select value={form.privacyTier ?? 'cloud'} onChange={(e) => setForm({ ...form, privacyTier: (e.target as HTMLSelectElement).value as 'local' | 'cloud' })}>
              <option value="cloud">{t('modelProfiles.cloud')}</option>
              <option value="local">{t('modelProfiles.local')}</option>
            </select>
          </label>
          <div class="field-stack">
            <span class="field-label">{t('modelProfiles.capabilities')}</span>
            <label class="toggle-row">
              <input
                type="checkbox"
                checked={form.capabilities?.vision ?? false}
                onChange={(e) => setForm({
                  ...form,
                  capabilities: { ...(form.capabilities ?? EMPTY_FORM.capabilities!), vision: (e.target as HTMLInputElement).checked },
                })}
              />
              <span class="toggle-text">
                <span class="toggle-label">{t('modelProfiles.vision')}</span>
                <span class="toggle-note">Image inputs, screenshots, OCR fallback</span>
              </span>
            </label>
            <label class="toggle-row">
              <input
                type="checkbox"
                checked={form.capabilities?.audio ?? false}
                onChange={(e) => setForm({
                  ...form,
                  capabilities: { ...(form.capabilities ?? EMPTY_FORM.capabilities!), audio: (e.target as HTMLInputElement).checked },
                })}
              />
              <span class="toggle-text">
                <span class="toggle-label">{t('modelProfiles.audio')}</span>
                <span class="toggle-note">Transcription / speech understanding</span>
              </span>
            </label>
            <label class="toggle-row">
              <input
                type="checkbox"
                checked={form.capabilities?.video ?? false}
                onChange={(e) => setForm({
                  ...form,
                  capabilities: { ...(form.capabilities ?? EMPTY_FORM.capabilities!), video: (e.target as HTMLInputElement).checked },
                })}
              />
              <span class="toggle-text">
                <span class="toggle-label">{t('modelProfiles.video')}</span>
                <span class="toggle-note">Frame-level video understanding</span>
              </span>
            </label>
          </div>
          <p class="settings-note">{t('modelProfiles.tagLocalNote')}</p>
          <div class="settings-actions">
              <button class="btn" onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}>{t('common.cancel')}</button>
              <button class="btn btn-primary" onClick={submitForm} disabled={!formValid}>{editingId ? t('modelProfiles.updateProfile') : t('modelProfiles.addProfile')}</button>
            </div>
          </div>
        ) : (
          <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowForm(true)}>{t('modelProfiles.addProfile')}</button>
          </div>
        )}

      {profiles.length > 0 && (
        <>
          <h3>{t('modelProfiles.roleAssignment')}</h3>
          <table class="ws-role-table">
            <tbody>
              {ROLES.map(({ role, label, hint }) => (
                <tr key={role}>
                  <td>
                    <strong>{t(label)}</strong>
                    <p class="settings-note">{t(hint)}</p>
                  </td>
                  <td>
                    <select value={settings.roleProfiles?.[role] ?? ''} onChange={(e) => setRoleProfile(role, (e.target as HTMLSelectElement).value)}>
                      <option value="">{t('modelProfiles.sameAsMain')}</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}{p.description ? ` — ${p.description}` : ''}</option>
                      ))}
                    </select>
                    {ROLE_CAPABILITY[role] && settings.roleProfiles?.[role] && !hasCapability(profiles.find((p) => p.id === settings.roleProfiles?.[role]), ROLE_CAPABILITY[role]!) && (
                      <p class="settings-note warn">{t('modelProfiles.roleCapabilityMissing').replace('{capability}', String(ROLE_CAPABILITY[role]))}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label class="memory-toggle">
            <input
              type="checkbox"
              checked={settings.restrictBackgroundToLocal ?? false}
              onChange={(e) => patch({ restrictBackgroundToLocal: (e.target as HTMLInputElement).checked })}
            />
              <span>{t('modelProfiles.restrictLocal')}</span>
            </label>
          <p class="settings-note">{t('modelProfiles.restrictLocalNote')}</p>
        </>
      )}
    </div>
  );
}
