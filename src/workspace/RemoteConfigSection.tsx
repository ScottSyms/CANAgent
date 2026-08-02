import { useState } from 'preact/hooks';
import { getSettingsForEdit, saveSettings } from '../background/storage';
import {
  diffRemoteConfig,
  droppedRemoteConfigKeys,
  fetchRemoteConfigJson,
  pickAllowedRemoteConfigFields,
  type ConfigDiffEntry,
} from '../shared/remoteConfig';
import type { Settings } from '../shared/types';

// Centrally configure the extension from a URL. Fetches JSON, keeps only a
// fixed allowlist of non-secret fields (never baseUrl/apiKey/modelProfiles —
// see remoteConfig.ts), shows exactly what would change, and applies only on
// explicit confirmation. A field-level merge onto the current settings, never
// a wholesale replace, so untouched secrets round-trip unchanged.

function formatValue(v: unknown): string {
  if (v === undefined) return '(not set)';
  if (typeof v === 'string') return v || '(empty)';
  return JSON.stringify(v);
}

export function RemoteConfigSection() {
  const [url, setUrl] = useState('');
  const [previewedUrl, setPreviewedUrl] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<ConfigDiffEntry[] | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [pending, setPending] = useState<Partial<Settings> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);

  const clearPreview = () => {
    setPreviewedUrl(null);
    setDiffs(null);
    setDropped([]);
    setPending(null);
    setApplied(false);
  };

  const fetchAndPreview = async () => {
    setError(null);
    setApplied(false);
    setBusy(true);
    try {
      const json = await fetchRemoteConfigJson(url.trim());
      const allowed = pickAllowedRemoteConfigFields(json);
      const { settings: current } = await getSettingsForEdit();
      setDiffs(diffRemoteConfig(current, allowed));
      setDropped(droppedRemoteConfigKeys(json));
      setPending(allowed);
      setPreviewedUrl(url.trim());
    } catch (e) {
      clearPreview();
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const apply = async () => {
    if (!pending) return;
    setError(null);
    setBusy(true);
    try {
      const { settings: current } = await getSettingsForEdit();
      await saveSettings({ ...current, ...pending });
      setApplied(true);
      setDiffs([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // A stale preview (the URL changed since the last fetch) must be re-fetched
  // before Apply is allowed, so Apply always reflects what's currently shown.
  const previewStale = previewedUrl !== null && previewedUrl !== url.trim();

  return (
    <details class="sites-section settings-acc">
      <summary class="settings-header settings-acc-summary">
        <strong>Central configuration</strong>
      </summary>
      <p class="settings-note">
        Fetch a JSON configuration from a URL and apply it. Only tuning/behavior fields can be set this way (model,
        temperature, token limits, prompt overrides, etc.) — the endpoint, API key, and model profiles can never be
        set from a remote URL and must be entered manually.
      </p>
      <label class="field">
        <span>Config URL</span>
        <input
          type="url"
          autocomplete="off"
          spellcheck={false}
          placeholder="https://example.com/canchat-config.json"
          value={url}
          onInput={(e) => {
            setUrl((e.target as HTMLInputElement).value);
            setApplied(false);
          }}
        />
      </label>
      <div class="settings-actions">
        <button class="btn btn-small" disabled={busy || !url.trim()} onClick={() => void fetchAndPreview()}>
          {busy ? 'Working…' : 'Fetch & Preview'}
        </button>
        {diffs && (
          <button class="btn btn-small" disabled={busy || previewStale || diffs.length === 0} onClick={() => void apply()}>
            {applied ? 'Applied' : 'Apply'}
          </button>
        )}
      </div>

      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}
      {previewStale && <p class="settings-note" style={{ color: 'var(--warn)' }}>The URL changed — fetch & preview again before applying.</p>}

      {diffs && !applied && (
        <>
          {diffs.length === 0 ? (
            <p class="settings-note">No applicable changes.</p>
          ) : (
            <table class="export-table" style={{ marginTop: '8px', fontSize: '12px' }}>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Current</th>
                  <th>New</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d) => (
                  <tr key={d.key}>
                    <td>{d.key}</td>
                    <td>{formatValue(d.before)}</td>
                    <td>{formatValue(d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dropped.length > 0 && (
            <p class="settings-note">
              Ignored (not settable this way): {dropped.join(', ')}
            </p>
          )}
        </>
      )}

      {applied && <p class="settings-note">Configuration applied.</p>}
    </details>
  );
}
