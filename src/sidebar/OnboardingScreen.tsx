// First-run setup — a minimal welcome instead of dropping the user into the full
// Settings modal (usability finding U2). Collects only the three required fields
// (endpoint, key, model), with Test connection, and an "Advanced setup" escape
// hatch to the full Settings overlay. Once saved, the app proceeds.

import { useState } from 'preact/hooks';
import type { TestConnectionResponse } from '../shared/messages';
import type { Settings } from '../shared/types';
import { useT } from './i18n';
import { useModalFocus } from './useModalFocus';

interface Props {
  /** `configured` is true once a valid model was saved. */
  onClose: (configured?: boolean) => void;
  /** Open the full Settings overlay (for Azure, embeddings, etc.). */
  onOpenAdvanced: () => void;
}

export function OnboardingScreen({ onClose, onOpenAdvanced }: Props) {
  const t = useT();
  const dialogRef = useModalFocus<HTMLDivElement>(() => onClose(false));
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);

  const valid = Boolean(baseUrl.trim() && apiKey.trim() && model.trim());

  const settings = (): Settings => ({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
  });

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'test_connection',
        settings: settings(),
      })) as TestConnectionResponse;
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, detail: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    await chrome.storage.local.set({ ba_settings: settings() });
    onClose(true);
  };

  return (
    <div class="settings-overlay">
      <div
        ref={dialogRef}
        class="settings-card onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
      >
        <div class="settings-header">
          <strong id="onboarding-title">{t('onboarding.title')}</strong>
        </div>

        <p class="settings-note">{t('onboarding.intro')}</p>

        <label class="field">
          <span>{t('settings.endpointUrl')}</span>
          <input
            type="url"
            autoFocus
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
          />
        </label>

        <label class="field">
          <span>{t('settings.apiKey')}</span>
          <input
            type="password"
            placeholder="sk-…"
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
          />
        </label>

        <label class="field">
          <span>{t('settings.model')}</span>
          <input
            type="text"
            placeholder="model-name"
            value={model}
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
          />
        </label>

        {testResult && (
          <div class={`banner ${testResult.ok ? 'banner-ok' : 'banner-error'}`}>{testResult.detail}</div>
        )}

        <div class="settings-actions">
          <button class="btn" onClick={test} disabled={!valid || testing}>
            {testing ? t('settings.testing') : t('settings.testConnection')}
          </button>
          <button class="btn btn-primary" onClick={save} disabled={!valid}>
            {t('onboarding.start')}
          </button>
        </div>

        <button class="link-btn onboarding-advanced" onClick={onOpenAdvanced}>
          {t('onboarding.advanced')}
        </button>
      </div>
    </div>
  );
}
