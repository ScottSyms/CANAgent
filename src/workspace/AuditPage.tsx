import { useEffect, useState } from 'preact/hooks';
import type { AuditEvent } from '../shared/audit';
import { getAuditIndex, readAuditEvents, type AuditIndexEntry } from '../shared/auditLog';

// The audit log is append-only JSONL in OPFS, written by the service worker as
// every policy decision, approval, and tool execution happens. OPFS is scoped to
// the extension origin and shared across its contexts, so this page reads the
// same files directly — no message round-trip. Digests only; never payloads.

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function short(digest: string | undefined): string {
  return digest ? digest.slice(0, 10) : '—';
}

const RESULT_CLASS: Record<string, string> = {
  success: 'ws-chip-ok',
  error: 'ws-chip-paused',
  denied: 'ws-chip-paused',
};

export function AuditPage() {
  const [index, setIndex] = useState<AuditIndexEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void getAuditIndex().then(setIndex);
  }, []);

  const open = async (conversationId: string) => {
    setSelected(conversationId);
    setLoading(true);
    try {
      const evts = await readAuditEvents(conversationId === 'unassigned' ? null : conversationId);
      setEvents([...evts].reverse()); // newest-first for reading
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="ws-audit-page">
      <h2>Audit</h2>
      <p class="settings-note">
        An append-only record of every policy decision, approval, and tool call — stored locally, digests only (no page
        content or credentials). One log per conversation.
      </p>
      {index.length === 0 && <div class="ws-empty">No audit events recorded yet.</div>}

      <div class="ws-audit-layout">
        <ul class="ws-audit-convos">
          {index.map((e) => (
            <li key={e.conversationId}>
              <button
                class={`ws-audit-convo ${selected === e.conversationId ? 'is-active' : ''}`}
                onClick={() => open(e.conversationId)}
              >
                <span class="ws-audit-convo-id">{e.conversationId === 'unassigned' ? '(unassigned)' : e.conversationId.slice(0, 8)}</span>
                <span class="ws-audit-convo-meta">{e.count} events · {fmt(e.lastTs)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div class="ws-audit-events">
          {loading && <div class="ws-empty">Loading…</div>}
          {!loading && selected && events.length === 0 && <div class="ws-empty">No events in this log.</div>}
          {!loading && events.length > 0 && (
            <table class="ws-audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Tool</th>
                  <th>Origin</th>
                  <th>Decision</th>
                  <th>Result</th>
                  <th>in→out</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.eventId}>
                    <td class="ws-dim">{new Date(ev.timestamp).toLocaleTimeString()}</td>
                    <td>{ev.eventType}{ev.unattended ? ' 🕒' : ''}</td>
                    <td>{ev.tool ?? '—'}</td>
                    <td class="ws-dim">{ev.target?.origin ?? '—'}</td>
                    <td>
                      {ev.policyDecision ?? '—'}
                      {ev.policyRule ? <span class="ws-dim"> ({ev.policyRule})</span> : null}
                    </td>
                    <td>
                      {ev.result ? <span class={`ws-chip ${RESULT_CLASS[ev.result] ?? ''}`}>{ev.result}</span> : '—'}
                    </td>
                    <td class="ws-dim" title={`${ev.inputDigest ?? ''} → ${ev.outputDigest ?? ''}`}>
                      {short(ev.inputDigest)}→{short(ev.outputDigest)}
                    </td>
                    <td class="ws-dim">{ev.durationMs != null ? Math.round(ev.durationMs) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
