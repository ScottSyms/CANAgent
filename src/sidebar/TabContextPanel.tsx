import { memo } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { SidebarCommand } from '../shared/messages';
import type { Skill, TabContextSummary } from '../shared/types';
import { useT } from './i18n';

interface Props {
  context: TabContextSummary | null;
  send: (command: SidebarCommand) => void;
  /** True while the agent is running, to disable quick-launch buttons. */
  busy: boolean;
}

const STALE_AFTER_MS = 5 * 60 * 1000;

/** Scale a data-URL image down to maxWidth, re-encoding as JPEG. */
async function downscale(dataUrl: string, maxWidth: number): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width <= maxWidth) return dataUrl;
  const scale = maxWidth / bitmap.width;
  const canvas = new OffscreenCanvas(maxWidth, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(out);
  });
}

export const TabContextPanel = memo(function TabContextPanel({ context, send, busy }: Props) {
  const t = useT();
  // Re-render every 30s so staleness indicators stay honest.
  const [, setTick] = useState(0);
  const [repo, setRepo] = useState('');
  const [repoNames, setRepoNames] = useState<string[]>([]);
  const [buttonSkills, setButtonSkills] = useState<Skill[]>([]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Skills pinned as toolbar buttons. Re-loaded live when skills change.
  useEffect(() => {
    const load = () => {
      chrome.storage.local.get('ba_skills').then((r) => {
        const all = Array.isArray(r.ba_skills) ? (r.ba_skills as Skill[]) : [];
        setButtonSkills(all.filter((s) => s.showButton));
      });
    };
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('ba_skills' in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Populate the repo dropdown with existing repository names. Re-fetched when
  // the field is focused so deletions made in Settings are reflected.
  const loadRepoNames = () => {
    chrome.runtime
      .sendMessage({ type: 'repo_list' })
      .then((list: Array<{ name: string }> | undefined) => {
        if (Array.isArray(list)) setRepoNames(list.map((r) => r.name));
      })
      .catch(() => {});
  };
  useEffect(() => {
    loadRepoNames();
  }, []);

  const addToRepo = (scope: 'tab' | 'group') => {
    if (!repo.trim()) return;
    send({ type: 'capture_to_repo', repo: repo.trim(), scope });
  };

  const snapshot = async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
    } catch {
      // Restricted pages (chrome://, Web Store) cannot be captured.
      return;
    }
    // Downscale so vision-token and storage costs stay sane.
    const scaled = await downscale(dataUrl, 1280);
    send({ type: 'attach_snapshot', dataUrl: scaled, title: tab.title ?? '', url: tab.url ?? '' });
  };

  const isStale = (capturedAt: string) =>
    Date.now() - new Date(capturedAt).getTime() > STALE_AFTER_MS;

  return (
    <div class="context-panel">
      <div class="context-actions">
        <button class="btn btn-small" title={t('context.screenshotHint')} onClick={snapshot}>
          {t('context.screenshot')}
        </button>
        <button
          class="btn btn-small"
          title={t('context.capturePageHint')}
          onClick={() => send({ type: 'capture_page' })}
        >
          {t('context.capturePage')}
        </button>
        <button
          class="btn btn-small"
          onClick={() => send({ type: 'refresh_context' })}
          disabled={!context}
        >
          {t('context.refresh')}
        </button>
        {buttonSkills.map((s) => (
          <button
            key={s.id}
            class="btn btn-small"
            title={s.description}
            disabled={busy}
            onClick={() => send({ type: 'user_message', text: `/${s.name}` })}
          >
            {s.buttonLabel?.trim() || `/${s.name}`}
          </button>
        ))}
      </div>
      <div class="repo-actions">
        <div class="repo-input-wrap">
          <input
            class="repo-input"
            type="text"
            list="repo-names"
            placeholder={t('context.knowledgeBase')}
            value={repo}
            onFocus={loadRepoNames}
            onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
          />
          {repo && (
            <button
              class="repo-clear"
              type="button"
              aria-label={t('context.clear')}
              title={t('context.clear')}
              onClick={() => setRepo('')}
            >
              ✕
            </button>
          )}
        </div>
        <datalist id="repo-names">
          {repoNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button
          class="btn btn-small"
          title={t('context.addTabHint')}
          disabled={!repo.trim()}
          onClick={() => addToRepo('tab')}
        >
          {t('context.addTab')}
        </button>
        <button
          class="btn btn-small"
          title={t('context.addGroupHint')}
          disabled={!repo.trim()}
          onClick={() => addToRepo('group')}
        >
          {t('context.addGroup')}
        </button>
      </div>
      {context && (
        <ul class="context-tabs">
          {context.tabs.map((ct) => (
            <li key={ct.tabId} class="context-tab" title={ct.url}>
              <span class={`dot dot-${ct.extractionStatus}`} />
              <span class="context-tab-title">{ct.title || ct.url}</span>
              {isStale(ct.capturedAt) && <span class="stale-tag">{t('context.stale')}</span>}
              {ct.extractionStatus !== 'ok' && ct.extractionStatus !== 'partial' && (
                <span class="stale-tag">{ct.extractionStatus}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
