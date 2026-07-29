// =============================================================================
// Sidebar — the side panel's root component and the UI half of the message
// protocol. It opens the long-lived Port to the service worker, mirrors the
// agent's broadcast events into local state (status, messages, plan, tool
// activity, approvals…), and renders the child panels. Commands flow out
// through `send`; nothing here runs agent logic — the background owns that.
//
// The Port is also kept warm with a periodic `ping` so the MV3 worker isn't
// evicted mid-task.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BackgroundEvent, SidebarCommand } from '../shared/messages';
import type {
  AgentStatus,
  ChatMessageView,
  PlanView,
  Settings,
  TabContextSummary,
  ToolActivity,
} from '../shared/types';
import { ChatPanel } from './ChatPanel';
import { ConversationsScreen } from './ConversationsScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { ProjectSwitcher } from './ProjectSwitcher';
import { exportConversationHtml } from './conversationExport';
import { useT } from './i18n';
import { OverflowMenu } from './OverflowMenu';
import { PlanPanel } from './PlanPanel';
import { TabContextPanel } from './TabContextPanel';
import { ToolActivityPanel } from './ToolActivityPanel';

/** Status label. Working states (thinking/acting) are conveyed by a calm pulse
   on the pill's status dot (CSS, gated behind prefers-reduced-motion) rather
   than per-letter font animation, which hurt legibility and accessibility. */
function StatusLabel({ status }: { status: AgentStatus }) {
  const t = useT();
  return <>{t(`status.${status}`)}</>;
}

// Monochrome line icons (Feather-style, MIT) used in the header. They inherit
// the button's currentColor so they match the theme and hover states — far
// tidier than the multi-colour emoji they replace.
const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
};
const IconHistory = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const IconSave = () => (
  <svg {...svgProps}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);

// "New chat" (compose). Clearing keeps the previous conversation in History
// (agentRuntime.clearConversation = "new chat", not delete), so a compose icon
// frames it honestly — far less alarming than the old trash can.
const IconNew = () => (
  <svg {...svgProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
// "Undo last exchange" — a counter-clockwise arrow.
const IconUndo = () => (
  <svg {...svgProps}>
    <path d="M3 7v6h6" />
    <path d="M3.5 13a9 9 0 1 0 2.6-6.4L3 9" />
  </svg>
);
const IconSettings = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/** Prepend plain-language guidance to a raw model/endpoint error (U6). */
function friendlyError(message: string, t: (k: string) => string): string {
  const m = message.toLowerCase();
  // Rate limits must be checked before the generic "model" branch below, since a
  // 429 message contains the word "model".
  if (m.includes('429') || m.includes('too_many_requests') || m.includes('rate limit')) {
    return `${t('error.rateLimited')} (${message})`;
  }
  if (m.includes('401') || m.includes('403') || m.includes('unauthor') || m.includes('api key')) {
    return `${t('error.checkKey')} (${message})`;
  }
  if (m.includes('could not reach') || m.includes('404') || m.includes('enotfound') || m.includes('fetch')) {
    return `${t('error.checkEndpoint')} (${message})`;
  }
  if (m.includes('400') || m.includes('model')) {
    return `${t('error.checkModel')} (${message})`;
  }
  return message;
}

export function Sidebar() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [context, setContext] = useState<TabContextSummary | null>(null);
  const [approval, setApproval] = useState<{ requestId: string; description: string; detail: string; approvalContext?: { toolName: string; capabilityKind?: string; capabilityName?: string; trustLevel?: string; authMethod?: string; authConfigured: boolean } } | null>(null);
  const [authNotice, setAuthNotice] = useState<{ origin: string; message: string } | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<{ origin: string; message: string } | null>(null);
  const [pendingSnapshots, setPendingSnapshots] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [canDistill, setCanDistill] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  // Pending prompt text to drop back into the composer after an undo.
  const [restoreDraft, setRestoreDraft] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [uiScale, setUiScale] = useState(() => {
    const s = Number(localStorage.getItem('ba_ui_scale'));
    return s >= 0.8 && s <= 1.6 ? s : 1;
  });

  const applyScale = (next: number) => {
    const clamped = Math.min(1.6, Math.max(0.8, Math.round(next * 10) / 10));
    setUiScale(clamped);
    document.documentElement.style.zoom = String(clamped);
    localStorage.setItem('ba_ui_scale', String(clamped));
  };

  const send = useCallback((command: SidebarCommand) => {
    portRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    chrome.storage.local.get('ba_settings').then((r) => {
      const s = r.ba_settings as Settings | undefined;
      const ok = Boolean(s?.baseUrl && s?.apiKey && s?.model);
      setConfigured(ok);
      if (!ok) setShowOnboarding(true);
    });

    let port: chrome.runtime.Port;
    let pingTimer: ReturnType<typeof setInterval>;

    const connect = () => {
      port = chrome.runtime.connect({ name: 'sidebar' });
      portRef.current = port;
      port.onMessage.addListener((event: BackgroundEvent) => {
        switch (event.type) {
          case 'full_state':
            setErrorBanner(null);
            setStatus(event.status);
            setMessages(event.messages);
            setActivities(event.activities);
            setContext(event.context);
            setApproval(event.pendingApproval as typeof approval);
            setAuthNotice(event.authNotice);
            setPermissionNotice(event.permissionNotice);
            setPendingSnapshots(event.pendingSnapshots);
            setPlan(event.plan);
            setCanDistill(event.canDistill);
            setCanUndo(event.canUndo);
            break;
          case 'chat_message':
            setMessages((m) => [...m, event.message]);
            break;
          case 'status':
            setStatus(event.status);
            if (event.status !== 'auth_required') setAuthNotice(null);
            if (event.status !== 'awaiting_approval') {
              setApproval(null);
              setPermissionNotice(null);
            }
            break;
          case 'tool_activity':
            setActivities((a) => {
              const idx = a.findIndex((x) => x.id === event.activity.id);
              if (idx >= 0) {
                const next = a.slice();
                next[idx] = { ...event.activity };
                return next;
              }
              return [...a, { ...event.activity }];
            });
            break;
          case 'approval_request':
            setApproval({ requestId: event.requestId, description: event.description, detail: event.detail, approvalContext: event.approvalContext });
            break;
          case 'auth_required':
            setAuthNotice(event.origin ? { origin: event.origin, message: event.message } : null);
            break;
          case 'permission_required':
            setPermissionNotice(event.origin ? { origin: event.origin, message: event.message } : null);
            break;
          case 'context_update':
            setContext(event.summary);
            break;
          case 'pending_snapshots':
            setPendingSnapshots(event.thumbs);
            break;
          case 'plan_update':
            setPlan(event.plan);
            break;
          case 'distill_offer':
            setCanDistill(event.available);
            break;
          case 'undo_available':
            setCanUndo(event.available);
            break;
          case 'undo_done':
            setRestoreDraft(event.restoredText);
            break;
          case 'error':
            setErrorBanner(event.message);
            break;
        }
      });
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        // Service worker restarted; reconnect after a beat.
        setTimeout(connect, 500);
      });
      // Keepalive ping so the service worker survives long waits.
      clearInterval(pingTimer);
      pingTimer = setInterval(() => port.postMessage({ type: 'ping' }), 20000);
    };

    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      // Settings are edited in the workspace tab now — watch storage so the
      // "no model" banner clears (and onboarding dismisses) the moment a
      // connection is saved there; there is no settings overlay to close.
      if (changes.ba_settings) {
        const s = changes.ba_settings.newValue as Settings | undefined;
        const ok = Boolean(s?.baseUrl && s?.apiKey && s?.model);
        setConfigured(ok);
        if (ok) setShowOnboarding(false);
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    connect();
    return () => {
      clearInterval(pingTimer);
      chrome.storage.onChanged.removeListener(onStorageChanged);
      port.disconnect();
    };
  }, []);

  const t = useT();

  // Most recent user message, for the error banner's Retry action (U6).
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';
  const retryLast = () => {
    if (!lastUserText) return;
    setErrorBanner(null);
    send({ type: 'user_message', text: lastUserText });
  };

  return (
    <div class="sidebar">
      <header class="header">
        <div class="brand">
          <span class="title" title={`CANChat Agent · build ${__APP_VERSION__}`}>CANChat Agent</span>
          <span class={`status status-${status}`}>
            <StatusLabel status={status} />
          </span>
        </div>
        <div class="header-controls">
          <ProjectSwitcher />
          <button class="icon-btn" aria-label={t('header.history')} title={t('header.history')} onClick={() => setShowHistory(true)}>
            <IconHistory />
          </button>
          <button
            class="new-chat-btn"
            aria-label={t('header.newChat')}
            title={t('header.newChat')}
            onClick={() => send({ type: 'clear_conversation' })}
            disabled={messages.length === 0}
          >
            <IconNew />
            <span>{t('header.newChatShort')}</span>
          </button>
          <OverflowMenu
            label={t('header.more')}
            embedded={
              <span class="scale-ctl">
                <button class="scale-btn" aria-label={t('header.smallerText')} title={t('header.smallerText')} onClick={() => applyScale(uiScale - 0.1)}>
                  A−
                </button>
                <button class="scale-val" aria-label={t('header.resetText')} title={t('header.resetText')} onClick={() => applyScale(1)}>
                  {Math.round(uiScale * 100)}%
                </button>
                <button class="scale-btn" aria-label={t('header.largerText')} title={t('header.largerText')} onClick={() => applyScale(uiScale + 0.1)}>
                  A+
                </button>
              </span>
            }
            items={[
              {
                id: 'save-conversation',
                label: t('header.saveConversation'),
                icon: <IconSave />,
                disabled: messages.length === 0,
                onSelect: () => exportConversationHtml(messages),
              },
              {
                id: 'undo',
                label: t('header.undoShort'),
                icon: <IconUndo />,
                disabled: !canUndo || status !== 'idle',
                onSelect: () => send({ type: 'undo_exchange' }),
              },
            ]}
          />
          <button
            class="icon-btn"
            aria-label={t('header.settings')}
            title={t('header.settings')}
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#settings') })}
          >
            <IconSettings />
          </button>
        </div>
      </header>

      {errorBanner && (
        <div class="banner banner-error">
          <span class="banner-msg">{friendlyError(errorBanner, t)}</span>
          <div class="banner-actions">
            {lastUserText && (
              <button class="link-btn" onClick={retryLast}>
                {t('error.retry')}
              </button>
            )}
            <button class="icon-btn" aria-label={t('common.dismiss')} title={t('common.dismiss')} onClick={() => setErrorBanner(null)}>
              ✕
            </button>
          </div>
        </div>
      )}

      {configured === false && !showOnboarding && (
        <div class="banner banner-warn">
          {t('header.noModel')}{' '}
          <button
            class="link-btn"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#models') })}
          >
            {t('header.openSettings')}
          </button>
        </div>
      )}

      <TabContextPanel
        context={context}
        send={send}
        busy={status === 'thinking' || status === 'acting' || status === 'awaiting_approval' || status === 'auth_required'}
      />

      <PlanPanel plan={plan} />

      <ChatPanel
        messages={messages}
        status={status}
        approval={approval}
        authNotice={authNotice}
        permissionNotice={permissionNotice}
        pendingSnapshots={pendingSnapshots}
        canDistill={canDistill}
        restoreDraft={restoreDraft}
        onRestoreConsumed={() => setRestoreDraft(null)}
        send={send}
        disabled={configured === false}
      />

      <ToolActivityPanel activities={activities} />

      {showOnboarding && (
        <OnboardingScreen
          onClose={(nowConfigured) => {
            setShowOnboarding(false);
            if (nowConfigured !== undefined) setConfigured(nowConfigured);
          }}
          onOpenAdvanced={() => {
            setShowOnboarding(false);
            void chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#models') });
          }}
        />
      )}

      {showHistory && <ConversationsScreen send={send} onClose={() => setShowHistory(false)} />}
    </div>
  );
}
