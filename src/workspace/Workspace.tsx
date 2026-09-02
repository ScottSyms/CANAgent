import { useEffect, useState } from 'preact/hooks';
import type { BackgroundEvent } from '../shared/messages';
import type { AgentStatus, ChatMessageView, DataExport, FileArtifact, PlanView } from '../shared/types';
import { CapabilitiesSection } from '../sidebar/CapabilitiesSection';
import { SkillsSection } from '../sidebar/SkillsSection';
import { useT } from '../sidebar/i18n';
import { AutomationsPage } from './AutomationsPage';
import { ConsoleSettingsPage } from './ConsoleSettingsPage';
import { ModelProfilesSection } from './ModelProfilesSection';
import { ModelSection } from './ModelSection';
import { ProvidersSection } from './ProvidersSection';
import { VaultSection } from './VaultSection';
import { AdvancedSettingsSection } from './AdvancedSettingsSection';
import { DataViewer } from './DataViewer';
import { ImageViewer } from './ImageViewer';
import { MemoryPage } from './MemoryPage';
import { MemorySection } from '../sidebar/MemorySection';
import { ProductsPage } from './ProductsPage';
import { ProjectsPage } from './ProjectsPage';
import { AuditPage } from './AuditPage';
import { JobsPage } from './JobsPage';

type WorkspaceView = 'chat' | 'projects' | 'tools' | 'skills' | 'models' | 'memory' | 'automations' | 'jobs' | 'products' | 'audit' | 'data' | 'image' | 'settings';
const VALID_VIEWS: WorkspaceView[] = ['chat', 'projects', 'tools', 'skills', 'models', 'memory', 'automations', 'jobs', 'products', 'audit', 'data', 'image', 'settings'];

function initialView(): WorkspaceView {
  const fromHash = location.hash.slice(1) as WorkspaceView;
  return VALID_VIEWS.includes(fromHash) ? fromHash : 'chat';
}

export function Workspace() {
  const t = useT();
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [exports, setExports] = useState<DataExport[]>([]);
  const [focusedExport, setFocusedExport] = useState<DataExport | null>(null);
  const [focusedImage, setFocusedImage] = useState<string | null>(null);
  const [focusedFileArtifact, setFocusedFileArtifact] = useState<FileArtifact | null>(null);
  const [port, setPort] = useState<chrome.runtime.Port | null>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    const p = chrome.runtime.connect({ name: 'sidebar' });
    p.postMessage({ type: 'get_state' });
    p.onMessage.addListener((event: BackgroundEvent) => {
      switch (event.type) {
        case 'full_state':
          setStatus(event.status);
          setMessages(event.messages);
          setPlan(event.plan);
          break;
        case 'chat_message': {
          setMessages((m) => [...m, event.message]);
          const exp = event.message.dataExport;
          if (exp) {
            setExports((prev) => {
              const next = prev.find((d) => d === exp) ? prev : [...prev, exp];
              if (next.length > 0) setFocusedExport(next[next.length - 1]);
              return next;
            });
          }
          if (event.message.fileArtifact) {
            setFocusedFileArtifact(event.message.fileArtifact);
          }
          if (event.message.images && event.message.images.length > 0) {
            setFocusedImage(event.message.images[0]);
          }
          break;
        }
        case 'status':
          setStatus(event.status);
          break;
        case 'plan_update':
          setPlan(event.plan);
          break;
      }
    });
    p.onDisconnect.addListener(() => {
      setPort(null);
    });
    setPort(p);
    return () => p.disconnect();
  }, []);

  const busy = status !== 'idle';
  const send = () => {
    const text = input.trim();
    if (!text || !port || busy) return;
    port.postMessage({ type: 'user_message', text });
    setInput('');
  };

  const latestExport = exports.length > 0 ? exports[exports.length - 1] : null;
  const displayExport = focusedExport ?? latestExport;

  const rightPane = () => {
    switch (view) {
      case 'projects':
        return <ProjectsPage />;
      case 'tools':
        return <CapabilitiesSection defaultOpen />;
      case 'skills':
        return (
          <div class="ws-skills-page">
            <SkillsSection />
          </div>
        );
      case 'models':
        return (
          <div class="ws-models-page">
            <ModelSection />
            <VaultSection />
            <AdvancedSettingsSection />
            <ModelProfilesSection />
            <ProvidersSection />
          </div>
        );
      case 'memory':
        return (
          <div class="ws-memory-view">
            <MemorySection />
            <MemoryPage />
          </div>
        );
      case 'automations':
        return <AutomationsPage />;
      case 'jobs':
        return <JobsPage />;
      case 'products':
        return <ProductsPage />;
      case 'audit':
        return <AuditPage />;
      case 'settings':
        return <ConsoleSettingsPage />;
      case 'data':
        return displayExport
          ? <DataViewer data={displayExport} allExports={exports} onSelectExport={setFocusedExport} />
          : <div class="ws-placeholder">No data export to view.</div>;
      case 'image':
        return focusedImage ? <ImageViewer imageUrl={focusedImage} /> : <div class="ws-placeholder">No image to view.</div>;
      default:
        return (
          <div class="ws-detail-panes">
            {latestExport && (
              <div class="ws-detail-card" onClick={() => setView('data')}>
                <strong>Latest data</strong>
                <p>{latestExport.title} ({latestExport.rows.length} rows{exports.length > 1 ? `, ${exports.length} exports` : ''})</p>
              </div>
            )}
            {focusedImage && (
              <div class="ws-detail-card" onClick={() => setView('image')}>
                <strong>Latest image</strong>
                <img src={focusedImage} alt="captured snapshot" class="ws-thumb" />
              </div>
            )}
            {focusedFileArtifact && (
              <div class="ws-detail-card">
                <strong>Latest file</strong>
                <p>{focusedFileArtifact.filename}</p>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div class="ws-root">
      <header class="ws-header glass-surface">
        <span class="ws-title">CANChat Agent</span>
        <nav class="ws-nav">
          <button class={`ws-nav-btn ${view === 'chat' ? 'is-active' : ''}`} onClick={() => setView('chat')}>{t('workspace.nav.chat')}</button>
          <button class={`ws-nav-btn ${view === 'projects' ? 'is-active' : ''}`} onClick={() => setView('projects')}>{t('workspace.nav.projects')}</button>
          <button class={`ws-nav-btn ${view === 'memory' ? 'is-active' : ''}`} onClick={() => setView('memory')}>{t('workspace.nav.memory')}</button>
          <button class={`ws-nav-btn ${view === 'automations' ? 'is-active' : ''}`} onClick={() => setView('automations')}>{t('workspace.nav.automations')}</button>
          <button class={`ws-nav-btn ${view === 'jobs' ? 'is-active' : ''}`} onClick={() => setView('jobs')}>Jobs</button>
          <button class={`ws-nav-btn ${view === 'products' ? 'is-active' : ''}`} onClick={() => setView('products')}>{t('workspace.nav.products')}</button>
          <button class={`ws-nav-btn ${view === 'audit' ? 'is-active' : ''}`} onClick={() => setView('audit')}>Audit</button>
          <button class={`ws-nav-btn ${view === 'skills' ? 'is-active' : ''}`} onClick={() => setView('skills')}>{t('workspace.nav.skills')}</button>
          <button class={`ws-nav-btn ${view === 'tools' ? 'is-active' : ''}`} onClick={() => setView('tools')}>{t('workspace.nav.tools')}</button>
          <button class={`ws-nav-btn ${view === 'models' ? 'is-active' : ''}`} onClick={() => setView('models')}>{t('workspace.nav.models')}</button>
          {displayExport && <button class={`ws-nav-btn ${view === 'data' ? 'is-active' : ''}`} onClick={() => setView('data')}>{t('workspace.nav.data')}{exports.length > 1 ? ` (${exports.length})` : ''}</button>}
          {focusedImage && <button class={`ws-nav-btn ${view === 'image' ? 'is-active' : ''}`} onClick={() => setView('image')}>{t('workspace.nav.image')}</button>}
          <button class={`ws-nav-btn ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView('settings')}>{t('workspace.nav.settings')}</button>
        </nav>
        <span class={`ws-status ws-status-${status}`}>
          <span class="ws-dot" />
          {status}
        </span>
      </header>
      <div class="ws-body">
        {/* The sidebar is chat context for every view and isn't useful on dedicated pages. */}
        {view !== 'data' && view !== 'image' && (
          <aside class="ws-sidebar">
            <div class="ws-message-list">
              {messages.map((m, i) => (
                <div key={i} class={`ws-msg ws-msg-${m.role}`}>
                  {m.text && <p>{m.text.slice(0, 200)}</p>}
                  {m.dataExport && <span class="ws-tag">Table: {m.dataExport.title}</span>}
                  {m.fileArtifact && <span class="ws-tag">File: {m.fileArtifact.filename}</span>}
                  {m.images && <span class="ws-tag">{m.images.length} image(s)</span>}
                </div>
              ))}
            </div>
            {plan && (
              <div class="ws-plan">
                <strong>Plan</strong>
                {plan.steps.map((s, i) => (
                  <div key={i} class={`ws-plan-step ws-plan-${s.status}`}>{s.text}</div>
                ))}
              </div>
            )}
            <div class="ws-composer">
              <textarea
                class="ws-composer-input"
                value={input}
                placeholder={busy ? 'Working…' : 'Message the agent…'}
                disabled={!port}
                onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button class="ws-btn ws-btn-primary" disabled={!input.trim() || busy || !port} onClick={send}>Send</button>
            </div>
          </aside>
        )}
        <main class="ws-main">
          {rightPane()}
        </main>
      </div>
    </div>
  );
}
