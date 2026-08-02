import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_PLAYBOOK_INDEX_URL } from '../shared/playbookIndex';
import { BackupRestoreSection } from '../sidebar/BackupRestoreSection';
import { DOCS_URL } from '../sidebar/links';
import { LANGUAGE_STORAGE_KEY, useT, type LangPref } from '../sidebar/i18n';
import { loadIndexUrl, saveIndexUrl } from '../sidebar/playbookSettings';
import { PromptsSection } from './PromptsSection';
import { RemoteConfigSection } from './RemoteConfigSection';

export function ConsoleSettingsPage() {
  const t = useT();
  const [langPref, setLangPref] = useState<LangPref>('auto');
  const [playbookUrl, setPlaybookUrl] = useState('');
  const [playbookSaved, setPlaybookSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(LANGUAGE_STORAGE_KEY).then((r) => {
      if (r[LANGUAGE_STORAGE_KEY]) setLangPref(r[LANGUAGE_STORAGE_KEY] as LangPref);
    });
    loadIndexUrl().then(setPlaybookUrl);
  }, []);

  const changeLanguage = (pref: LangPref) => {
    setLangPref(pref);
    void chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: pref });
  };

  const savePlaybookUrl = async () => {
    await saveIndexUrl(playbookUrl);
    // Reflect normalization (blank → default) back into the field.
    setPlaybookUrl(await loadIndexUrl());
    setPlaybookSaved(true);
    setTimeout(() => setPlaybookSaved(false), 2500);
  };

  return (
    <div class="ws-settings-page">
      <h2>{t('settings.title')}</h2>

      <label class="field">
        <span>{t('settings.language')}</span>
        <select
          value={langPref}
          onChange={(e) => changeLanguage((e.target as HTMLSelectElement).value as LangPref)}
        >
          <option value="auto">{t('settings.languageAuto')}</option>
          <option value="en">{t('settings.languageEn')}</option>
          <option value="fr">{t('settings.languageFr')}</option>
        </select>
      </label>
      <p class="settings-note">{t('settings.languageNote')}</p>

      <label class="field">
        <span>{t('settings.playbookIndexUrl')}</span>
        <input
          type="url"
          autocomplete="off"
          spellcheck={false}
          placeholder={DEFAULT_PLAYBOOK_INDEX_URL}
          value={playbookUrl}
          onInput={(e) => setPlaybookUrl((e.target as HTMLInputElement).value)}
        />
      </label>
      <p class="settings-note">{t('settings.playbookIndexUrlNote')}</p>
      <div class="settings-actions">
        <button class="btn btn-small" onClick={savePlaybookUrl}>
          {t('common.save')}
        </button>
        {playbookUrl.trim() !== DEFAULT_PLAYBOOK_INDEX_URL && (
          <button
            class="btn btn-small"
            onClick={async () => {
              setPlaybookUrl(DEFAULT_PLAYBOOK_INDEX_URL);
              await saveIndexUrl(DEFAULT_PLAYBOOK_INDEX_URL);
            }}
          >
            {t('settings.playbookIndexUrlReset')}
          </button>
        )}
        {playbookSaved && <span class="settings-note">{t('settings.saved')}</span>}
      </div>

      <PromptsSection />

      <RemoteConfigSection />

      <BackupRestoreSection defaultOpen />

      <div class="settings-about">
        <span>CANChat Agent · build {__APP_VERSION__}</span>
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          {t('settings.help')}
        </a>
      </div>
    </div>
  );
}
