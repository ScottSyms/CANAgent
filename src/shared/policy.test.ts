import { describe, expect, it } from 'vitest';
import {
  classifyTool,
  evaluatePolicy,
  isApprovalStillValid,
  TOOL_ACTION_CLASS,
  type ActionClass,
  type PolicyInput,
} from './policy';

const EMPTY = new Set<string>();
const READ_ONLY = new Set(['get_tab_content', 'list_tabs']);

function base(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tool: 'x',
    actionClass: 'read',
    attended: true,
    sessionApprovedTools: EMPTY,
    ...overrides,
  };
}

describe('evaluatePolicy — attended', () => {
  it('allows plain reads', () => {
    expect(evaluatePolicy(base({ actionClass: 'read' })).kind).toBe('allow');
  });

  it('allows low-risk writes with no prompt (visible indication is a UI concern)', () => {
    expect(evaluatePolicy(base({ actionClass: 'low_risk_write' })).kind).toBe('allow');
  });

  it.each<ActionClass>(['external_comms', 'record_modification', 'destructive'])(
    'requires approval for %s',
    (cls) => {
      const d = evaluatePolicy(base({ actionClass: cls }));
      expect(d.kind).toBe('needs_approval');
    },
  );

  it('always denies financial/legal, even attended', () => {
    const d = evaluatePolicy(base({ actionClass: 'financial_legal' }));
    expect(d).toEqual({ kind: 'deny', rule: 'financial_legal_disabled' });
  });

  it('escalates a read from a low-trust capability to approval', () => {
    const d = evaluatePolicy(base({ actionClass: 'read', capabilityKind: 'mcp', trustLevel: 'public' }));
    expect(d.kind).toBe('needs_approval');
  });

  it('auto-allows a read from an enterprise-trust capability', () => {
    const d = evaluatePolicy(base({ actionClass: 'read', capabilityKind: 'mcp', trustLevel: 'enterprise' }));
    expect(d.kind).toBe('allow');
  });
});

describe('evaluatePolicy — session approval short-circuit', () => {
  it('allows a previously session-approved external-comms tool', () => {
    const d = evaluatePolicy(base({ tool: 'submit_form', actionClass: 'external_comms', sessionApprovedTools: new Set(['submit_form']) }));
    expect(d.kind).toBe('allow');
  });

  it('does NOT let session approval cover destructive actions', () => {
    const d = evaluatePolicy(base({ tool: 'run_javascript', actionClass: 'destructive', sessionApprovedTools: new Set(['run_javascript']) }));
    expect(d.kind).toBe('needs_approval');
  });

  it('does NOT let session approval cover financial/legal', () => {
    const d = evaluatePolicy(base({ tool: 'pay', actionClass: 'financial_legal', sessionApprovedTools: new Set(['pay']) }));
    expect(d.kind).toBe('deny');
  });
});

describe('evaluatePolicy — unattended', () => {
  it('allows a plain read', () => {
    expect(evaluatePolicy(base({ attended: false, actionClass: 'read' })).kind).toBe('allow');
  });

  it('denies any non-read action', () => {
    const d = evaluatePolicy(base({ attended: false, actionClass: 'external_comms' }));
    expect(d).toEqual({ kind: 'deny', rule: 'unattended_requires_approval' });
  });

  it('denies an unattended-blocked tool even if read', () => {
    const d = evaluatePolicy(base({ attended: false, actionClass: 'read', tool: 'x', unattendedBlockedTools: new Set(['x']) }));
    expect(d).toEqual({ kind: 'deny', rule: 'unattended_blocked' });
  });

  it('denies a low-trust capability read (cannot prompt when unattended)', () => {
    const d = evaluatePolicy(base({ attended: false, actionClass: 'read', capabilityKind: 'mcp', trustLevel: 'public' }));
    expect(d).toEqual({ kind: 'deny', rule: 'unattended_low_trust_capability' });
  });
});

describe('classifyTool', () => {
  it('uses the explicit table where present', () => {
    expect(classifyTool('submit_form', READ_ONLY)).toBe('external_comms');
    expect(classifyTool('run_javascript', READ_ONLY)).toBe('destructive');
  });

  it('falls back to read for known read-only tools', () => {
    expect(classifyTool('list_tabs', READ_ONLY)).toBe('read');
  });

  it('falls back to external_comms (asks) for unknown tools', () => {
    expect(classifyTool('some_new_tool', READ_ONLY)).toBe('external_comms');
  });

  it('never classifies a page-mutating tool as read', () => {
    for (const [tool, cls] of Object.entries(TOOL_ACTION_CLASS)) {
      if (cls === 'read') expect(tool).not.toMatch(/submit|click|run_javascript|drag|press_keys/);
    }
  });
});

describe('isApprovalStillValid — approval binding', () => {
  it('rejects an approval granted after expiry', () => {
    expect(isApprovalStillValid(1000, 1001)).toBe(false);
  });
  it('accepts an approval granted before expiry', () => {
    expect(isApprovalStillValid(1000, 999)).toBe(true);
  });
  it('treats an unbound (undefined) expiry as valid', () => {
    expect(isApprovalStillValid(undefined, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
