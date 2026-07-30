import { useEffect, useState } from 'preact/hooks';
import {
  changePassphrase,
  eraseVault,
  getVaultState,
  lockVault,
  setupVault,
  unlockVault,
  type VaultState,
} from '../background/vault';
import { getSettingsForEdit, saveSettings, sealSecretsAtRest } from '../background/storage';
import { Group } from './SettingsControls';

// Manage the application-layer encryption vault (specification.md §8.8): a
// passphrase-derived key wraps the per-install data key that encrypts secrets at
// rest. Opt-in — with no vault, everything stays as before. Runs in the page
// context; vault.ts uses only chrome.storage, and the unlocked key it caches in
// session storage is shared with the service worker, so unlocking here unlocks
// the agent too.
export function VaultSection() {
  const [state, setState] = useState<VaultState | null>(null);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => getVaultState().then(setState);
  useEffect(() => {
    refresh();
  }, []);

  const reset = () => {
    setPass('');
    setConfirm('');
    setNext('');
  };

  const create = async () => {
    if (pass.length < 8) return setMsg({ ok: false, text: 'Use a passphrase of at least 8 characters.' });
    if (pass !== confirm) return setMsg({ ok: false, text: 'The passphrases do not match.' });
    setBusy(true);
    try {
      await setupVault(pass);
      await sealSecretsAtRest(); // encrypt an API key that was entered in plaintext
      setMsg({ ok: true, text: 'Encryption enabled. Your secrets are now encrypted at rest.' });
      reset();
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    try {
      const ok = await unlockVault(pass);
      setMsg(ok ? { ok: true, text: 'Vault unlocked.' } : { ok: false, text: 'Incorrect passphrase.' });
      if (ok) reset();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    await lockVault();
    setMsg({ ok: true, text: 'Vault locked. The agent will need it unlocked to run.' });
    await refresh();
  };

  const change = async () => {
    if (next.length < 8) return setMsg({ ok: false, text: 'Use a new passphrase of at least 8 characters.' });
    setBusy(true);
    try {
      const ok = await changePassphrase(pass, next);
      setMsg(ok ? { ok: true, text: 'Passphrase changed.' } : { ok: false, text: 'Current passphrase is incorrect.' });
      if (ok) reset();
    } finally {
      setBusy(false);
    }
  };

  // Erase = cryptographic destruction of the wrapped key. To avoid locking the
  // user out of their own API key, first read it back in plaintext (only possible
  // while unlocked) and re-store it after the vault is gone.
  const erase = async () => {
    if (!confirm.toLowerCase().startsWith('erase')) {
      return setMsg({ ok: false, text: 'Type "erase" to confirm destroying the vault.' });
    }
    setBusy(true);
    try {
      const { settings } = await getSettingsForEdit();
      await eraseVault();
      if (settings.apiKey) await saveSettings(settings); // now plaintext (no vault)
      setMsg({ ok: true, text: 'Vault erased. Encrypted data was destroyed; your API key was preserved in plaintext.' });
      reset();
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return null;

  return (
    <div class="ws-vault-section">
      <Group title="Encryption vault" desc="Encrypt secrets at rest with a passphrase-derived key. Optional; the passphrase is never stored and cannot be recovered.">
        {msg && <div class={`banner ${msg.ok ? 'banner-ok' : 'banner-error'}`}>{msg.text}</div>}

        {state === 'none' && (
          <>
            <label class="field">
              <span>Passphrase</span>
              <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} placeholder="at least 8 characters" />
            </label>
            <label class="field">
              <span>Confirm passphrase</span>
              <input type="password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
            </label>
            <p class="field-note">If you forget this passphrase, encrypted data cannot be recovered — there is no backdoor.</p>
            <div class="settings-actions">
              <button class="btn btn-primary" onClick={create} disabled={busy || !pass}>Enable encryption</button>
            </div>
          </>
        )}

        {state === 'locked' && (
          <>
            <label class="field">
              <span>Passphrase</span>
              <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
            </label>
            <div class="settings-actions">
              <button class="btn btn-primary" onClick={unlock} disabled={busy || !pass}>Unlock</button>
            </div>
          </>
        )}

        {state === 'unlocked' && (
          <>
            <div class="banner banner-ok">🔓 Vault is unlocked. Secrets are encrypted at rest and readable this session.</div>
            <label class="field">
              <span>Current passphrase (to change or erase)</span>
              <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>New passphrase</span>
              <input type="password" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} placeholder="at least 8 characters" />
            </label>
            <div class="settings-actions">
              <button class="btn" onClick={lock} disabled={busy}>Lock now</button>
              <button class="btn" onClick={change} disabled={busy || !pass || !next}>Change passphrase</button>
            </div>
            <label class="field">
              <span>Type "erase" to destroy the vault</span>
              <input type="text" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} placeholder="erase" />
            </label>
            <div class="settings-actions">
              <button class="btn btn-danger" onClick={erase} disabled={busy}>Erase vault</button>
            </div>
          </>
        )}
      </Group>
    </div>
  );
}
