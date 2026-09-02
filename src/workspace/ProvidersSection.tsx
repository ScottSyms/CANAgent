import { useEffect, useState } from 'preact/hooks';
import type { ProviderId } from '../shared/messages';
import type { Settings } from '../shared/types';
import { getSettingsForEdit, saveSettings } from '../background/storage';

// =============================================================================
// "Subscription Providers" card list — connect/disconnect GitHub Copilot,
// GitLab Duo, ChatGPT/Codex, and xAI/SuperGrok. Every card shows the same
// truthful decision + capability info regardless of provider (see
// background/providers/registry.ts) — this component never special-cases a
// provider id beyond which config fields it needs (client id / instance URL)
// and the device-flow "enter this code" step GitHub's flow requires.
// =============================================================================

interface ProviderDescriptorLike {
  id: ProviderId;
  name: string;
  mark: string;
  decision: 'direct' | 'local_companion' | 'api_key_only' | 'blocked';
  capabilities: {
    tools: boolean;
    images: boolean;
    reasoning: boolean;
    streaming: boolean;
    authModes: string[];
  };
  summary: string;
}

interface StatusInfo {
  status: 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error' | 'unsupported';
  detail?: string;
}

interface AccountInfoLike {
  label: string;
  login?: string;
  organization?: string;
  plan?: string;
  note?: string;
}

interface ModelInfoLike {
  id: string;
  label: string;
}

interface QuotaLike {
  available: boolean;
  used?: number;
  limit?: number;
  unit?: string;
  resetAt?: string;
  reason?: string;
}

const DECISION_LABEL: Record<ProviderDescriptorLike['decision'], string> = {
  direct: 'Direct sign-in',
  local_companion: 'Sign-in direct · chat needs local companion',
  api_key_only: 'API key only',
  blocked: 'Subscription sign-in not supported',
};

const EMPTY_SETTINGS: Settings = { baseUrl: '', apiKey: '', model: '' };

async function loadSettings(): Promise<Settings> {
  return (await getSettingsForEdit()).settings;
}

function send<T = Record<string, unknown>>(request: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}

function ProviderCard({
  descriptor,
  settings,
  onSettingsPatch,
}: {
  descriptor: ProviderDescriptorLike;
  settings: Settings;
  onSettingsPatch: (patch: Partial<Settings>) => void;
}) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [account, setAccount] = useState<AccountInfoLike | null>(null);
  const [models, setModels] = useState<ModelInfoLike[]>([]);
  const [quota, setQuota] = useState<QuotaLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<{ verificationUri?: string; userCode?: string } | null>(null);

  const refresh = async () => {
    const s = await send<{ ok: boolean; status?: StatusInfo }>({ type: 'provider_status', provider: descriptor.id });
    setStatus(s.status ?? null);
    if (s.status?.status === 'connected') {
      const [a, m, q] = await Promise.all([
        send<{ ok: boolean; account?: AccountInfoLike | null }>({ type: 'provider_account', provider: descriptor.id }),
        send<{ ok: boolean; models?: ModelInfoLike[] }>({ type: 'provider_models', provider: descriptor.id }),
        send<{ ok: boolean; quota?: QuotaLike }>({ type: 'provider_quota', provider: descriptor.id }),
      ]);
      setAccount(a.account ?? null);
      setModels(m.models ?? []);
      setQuota(q.quota ?? null);
    } else {
      setAccount(null);
      setModels([]);
      setQuota(null);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor.id]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setDeviceCode(null);
    try {
      const res = await send<{ ok: boolean; result?: { verificationUri?: string; userCode?: string }; error?: string }>({
        type: 'provider_connect',
        provider: descriptor.id,
      });
      if (!res.ok) throw new Error(res.error ?? 'Connect failed.');
      if (res.result?.userCode) {
        // Device flow: show the code, then poll in the background until the
        // user finishes authorizing on the provider's site.
        setDeviceCode(res.result);
        const poll = await send<{ ok: boolean; error?: string }>({ type: 'provider_complete_oauth', provider: descriptor.id });
        if (!poll.ok) throw new Error(poll.error ?? 'Sign-in failed.');
        setDeviceCode(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const disconnect = async () => {
    setBusy(true);
    await send({ type: 'provider_disconnect', provider: descriptor.id });
    await refresh();
    setBusy(false);
  };

  const connected = status?.status === 'connected';
  const canConnect = descriptor.capabilities.authModes.some(
    (m) => m === 'oauth-device' || m === 'oauth-pkce' || m === 'local-companion',
  );

  return (
    <div class="site-row provider-card">
      <div class="site-main">
        <div class="site-row-top">
          <span class="provider-mark" aria-hidden="true">{descriptor.mark}</span>
          <span class="site-name">{descriptor.name}</span>
          <span class="approval-tag approval-cap">{DECISION_LABEL[descriptor.decision]}</span>
        </div>
        <span class="site-desc">{descriptor.summary}</span>

        {descriptor.id === 'github-copilot' && (
          <label class="field">
            <span>GitHub OAuth App Client ID</span>
            <input
              type="text"
              value={settings.githubCopilotClientId ?? ''}
              placeholder="Iv1.xxxxxxxxxxxxxxxx"
              onInput={(e) => onSettingsPatch({ githubCopilotClientId: (e.target as HTMLInputElement).value })}
            />
          </label>
        )}
        {descriptor.capabilities.authModes.includes('oauth-pkce') && (
          <>
            <label class="field">
              <span>GitLab instance URL</span>
              <input
                type="text"
                value={settings.gitlabInstanceUrl ?? ''}
                placeholder="https://gitlab.com"
                onInput={(e) => onSettingsPatch({ gitlabInstanceUrl: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label class="field">
              <span>OAuth Application Client ID</span>
              <input
                type="text"
                value={settings.gitlabDuoClientId ?? ''}
                placeholder="application client id"
                onInput={(e) => onSettingsPatch({ gitlabDuoClientId: (e.target as HTMLInputElement).value })}
              />
            </label>
          </>
        )}

        {canConnect && (
          <div class="repo-folder-row">
            {!connected ? (
              <button class="btn" disabled={busy} onClick={() => void connect()}>Connect</button>
            ) : (
              <button class="btn" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
            )}
          </div>
        )}

        {deviceCode?.userCode && (
          <p class="settings-note">
            Go to <strong>{deviceCode.verificationUri}</strong> and enter code <strong>{deviceCode.userCode}</strong>.
          </p>
        )}
        {error && <p class="settings-note">{error}</p>}
        {status && status.status !== 'connected' && status.detail && <p class="settings-note">{status.detail}</p>}

        {connected && (
          <div class="site-note">
            {account && <div>Account: {account.label}{account.plan ? ` (${account.plan})` : ''}</div>}
            {account?.note && <div>{account.note}</div>}
            {models.length > 0 && <div>Models: {models.map((m) => m.label).join(', ')}</div>}
            {quota && (quota.available
              ? <div>Quota: {quota.used ?? '?'} / {quota.limit ?? '?'} {quota.unit ?? ''}{quota.resetAt ? ` · resets ${new Date(quota.resetAt).toLocaleString()}` : ''}</div>
              : <div>Quota: {quota.reason}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProvidersSection() {
  const [descriptors, setDescriptors] = useState<ProviderDescriptorLike[]>([]);
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);

  useEffect(() => {
    send<{ ok: boolean; providers?: ProviderDescriptorLike[] }>({ type: 'provider_list' }).then((r) =>
      setDescriptors(r.providers ?? []),
    );
    loadSettings().then(setSettings);
  }, []);

  const patch = async (next: Partial<Settings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    const { settings: current } = await getSettingsForEdit();
    await saveSettings({ ...current, ...next });
  };

  return (
    <div class="ws-model-profiles">
      <h3>Subscription Providers</h3>
      <p class="settings-note">
        Use subscription quota only through verified provider integrations. Blocked entries remain visible so unsupported
        third-party login is never mistaken for a missing setting. See docs/providers.md for setup and billing details.
      </p>
      <ul class="sites-list">
        {descriptors.map((d) => (
          <li key={d.id}>
            <ProviderCard descriptor={d} settings={settings} onSettingsPatch={patch} />
          </li>
        ))}
      </ul>
    </div>
  );
}
