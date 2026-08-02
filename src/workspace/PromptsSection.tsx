import { useEffect, useState } from 'preact/hooks';
import { getSettingsForEdit, saveSettings } from '../background/storage';
import { DEFAULT_PROMPTS, pruneEmptyOverrides } from '../shared/promptDefaults';
import type { PromptKey, Settings } from '../shared/types';

// Lets a user replace (not append — that's settings.systemPrompt) the six
// notebook/graph/studio synthesis prompts. The core agent system prompt and
// tool-behavior prompts (rerank, query-variant, reflection) are deliberately
// not exposed here — see src/shared/promptDefaults.ts.

const PROMPT_LABELS: Record<PromptKey, string> = {
  notebookOverview: 'Notebook overview',
  graphExtraction: 'Knowledge graph extraction',
  communitySummary: 'Theme (community) summary',
  studioBriefing: 'Studio: Briefing',
  studioFaq: 'Studio: FAQ',
  studioStudyGuide: 'Studio: Study guide',
};

const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS) as PromptKey[];

export function PromptsSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<PromptKey, string>>>({});
  const [saved, setSaved] = useState<PromptKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { settings: s } = await getSettingsForEdit();
      setSettings(s);
      setDrafts(s.promptOverrides ?? {});
    })();
  }, []);

  const save = async (key: PromptKey) => {
    if (!settings) return;
    setError(null);
    try {
      const promptOverrides = pruneEmptyOverrides({ ...settings.promptOverrides, [key]: drafts[key] });
      const next = { ...settings, promptOverrides };
      await saveSettings(next);
      setSettings(next);
      setSaved(key);
      setTimeout(() => setSaved((k) => (k === key ? null : k)), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reset = async (key: PromptKey) => {
    setDrafts((d) => ({ ...d, [key]: undefined }));
    if (!settings) return;
    setError(null);
    try {
      const { [key]: _dropped, ...rest } = settings.promptOverrides ?? {};
      const promptOverrides = pruneEmptyOverrides(rest);
      const next = { ...settings, promptOverrides };
      await saveSettings(next);
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!settings) return null;

  return (
    <details class="sites-section settings-acc">
      <summary class="settings-header settings-acc-summary">
        <strong>Prompts</strong>
      </summary>
      <p class="settings-note">
        Replace the built-in prompts for the notebook overview, knowledge graph, and studio features. Leave a field
        blank (or Reset) to use the default. The core agent prompt and internal tool-behavior prompts are not
        editable here, to keep citations and tool-calling working reliably.
      </p>
      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}
      {PROMPT_KEYS.map((key) => {
        const isOverridden = !!settings.promptOverrides?.[key];
        const value = drafts[key] ?? (isOverridden ? settings.promptOverrides![key] : '');
        return (
          <div key={key} class="field" style={{ marginBottom: '12px' }}>
            <span>
              {PROMPT_LABELS[key]} {isOverridden && <em style={{ color: 'var(--accent)' }}>(customized)</em>}
            </span>
            <textarea
              rows={5}
              placeholder={DEFAULT_PROMPTS[key]}
              value={value}
              onInput={(e) => setDrafts((d) => ({ ...d, [key]: (e.target as HTMLTextAreaElement).value }))}
              style={{ width: '100%', fontFamily: 'inherit', fontSize: '12px' }}
            />
            <div class="settings-actions">
              <button class="btn btn-small" onClick={() => void save(key)}>
                {saved === key ? 'Saved' : 'Save'}
              </button>
              {isOverridden && (
                <button class="btn btn-small" onClick={() => void reset(key)}>
                  Reset to default
                </button>
              )}
            </div>
          </div>
        );
      })}
    </details>
  );
}
