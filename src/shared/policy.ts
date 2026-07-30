// =============================================================================
// Policy engine — the single, pure allow/deny/needs-approval decision for a
// tool call. Extracted from the inline boolean that used to live in
// AgentRuntime.executeToolCall so the risk model is inspectable data
// (TOOL_ACTION_CLASS) and testable logic (evaluatePolicy), not Set membership
// buried in the loop.
//
// Precedence mirrors the instruction hierarchy in specification.md §12.2:
// enterprise/system policy outranks everything, and *page content never reaches
// this function* — pages only ever feed `tool`/`args`, never the decision. This
// module is pure (no chrome.*, no I/O) so it unit-tests in the Node env.
// =============================================================================

/**
 * Action classes from specification.md §12.3, ordered by escalating control.
 * The ordering matters: `actionRank` uses it for the "session approval only
 * short-circuits up to record modification" rule.
 */
export type ActionClass =
  | 'read' // read page, extract text — domain permission only
  | 'low_risk_write' // draft text in an unsent form — visible indication
  | 'external_comms' // send email, submit message — user approval
  | 'record_modification' // update Jira/SharePoint/schedule — user approval
  | 'destructive' // delete, revoke, cancel, run arbitrary code — strong confirm
  | 'financial_legal'; // approve payment/agreement — disabled by default

const ACTION_ORDER: ActionClass[] = [
  'read',
  'low_risk_write',
  'external_comms',
  'record_modification',
  'destructive',
  'financial_legal',
];

export function actionRank(cls: ActionClass): number {
  return ACTION_ORDER.indexOf(cls);
}

export interface PolicyInput {
  tool: string;
  actionClass: ActionClass;
  /** Attended chat (a human is present) vs. an unattended scheduled/triggered run. */
  attended: boolean;
  /** Trust level of the sourcing capability, if the tool came from the registry. */
  trustLevel?: string;
  capabilityKind?: string;
  /** Tools the user already approved "for this session". */
  sessionApprovedTools: ReadonlySet<string>;
  /** Tools that are fine attended but must never run unattended (silent). */
  unattendedBlockedTools?: ReadonlySet<string>;
}

export type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'needs_approval'; reasonClass: ActionClass }
  | { kind: 'deny'; rule: string };

/** Trust levels at or above `enterprise` auto-approve capability-sourced tools. */
const TRUST_ORDER = ['public', 'community', 'verified', 'enterprise', 'local'];
function trustRank(level: string | undefined): number {
  const i = TRUST_ORDER.indexOf(level ?? 'public');
  return i < 0 ? 0 : i;
}
function isTrusted(level: string | undefined): boolean {
  return trustRank(level) >= TRUST_ORDER.indexOf('enterprise');
}

/**
 * The whole decision, in precedence order. Higher rules win — a later branch
 * can never grant what an earlier branch denied.
 *
 *   1. financial/legal is always denied (spec §12.3 "disabled by default").
 *   2. unattended runs may only perform read-class work (and never a
 *      tool on the unattended-blocked list).
 *   3. a tool the user approved for the session is allowed, but only up to
 *      record_modification — never for destructive/financial actions.
 *   4. read-class: allowed outright for trusted capabilities, else approval
 *      when it came from a low-trust capability.
 *   5. low-risk writes are allowed (the UI shows a visible indication).
 *   6. everything else (external comms, record mods, destructive) needs approval.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { tool, actionClass, attended, trustLevel, sessionApprovedTools } = input;

  // 1 — financial/legal off by default, in every context.
  if (actionClass === 'financial_legal') {
    return { kind: 'deny', rule: 'financial_legal_disabled' };
  }

  // 2 — unattended runs are read-only and never touch blocked tools.
  if (!attended) {
    if (input.unattendedBlockedTools?.has(tool)) {
      return { kind: 'deny', rule: 'unattended_blocked' };
    }
    if (actionClass !== 'read') {
      return { kind: 'deny', rule: 'unattended_requires_approval' };
    }
    // A read from a low-trust capability still can't get interactive approval
    // when unattended, so deny rather than hang.
    if (!isTrusted(trustLevel) && input.capabilityKind) {
      return { kind: 'deny', rule: 'unattended_low_trust_capability' };
    }
    return { kind: 'allow' };
  }

  // 3 — session approval short-circuits, but not for the two most dangerous
  // classes: a "remember for session" tick must never blanket-authorize
  // deletes or payments.
  if (
    sessionApprovedTools.has(tool) &&
    actionRank(actionClass) <= actionRank('record_modification')
  ) {
    return { kind: 'allow' };
  }

  // 4 — read-class.
  if (actionClass === 'read') {
    if (input.capabilityKind && !isTrusted(trustLevel)) {
      return { kind: 'needs_approval', reasonClass: 'read' };
    }
    return { kind: 'allow' };
  }

  // 5 — low-risk writes proceed with a visible indication (UI concern).
  if (actionClass === 'low_risk_write') {
    return { kind: 'allow' };
  }

  // 6 — external comms, record modification, destructive.
  return { kind: 'needs_approval', reasonClass: actionClass };
}

/**
 * Risk classification per tool. This is the inspectable, diff-reviewable
 * replacement for the old APPROVAL_REQUIRED Set. Anything not listed falls back
 * to `read` when it is a known read-only tool, else `external_comms` (see
 * classifyTool) — a safe default that errs toward asking.
 */
export const TOOL_ACTION_CLASS: Record<string, ActionClass> = {
  // --- read -------------------------------------------------------------
  list_tabs: 'read',
  get_active_tab: 'read',
  get_tab_content: 'read',
  get_element_map: 'read',
  detect_auth_state: 'read',
  wait_for_element: 'read',
  search_known_sites: 'read',
  list_mcp_tools: 'read',
  list_webmcp_tools: 'read',
  sharepoint_search: 'read',
  microsoft365_search: 'read',
  calendar_search: 'read',
  list_scheduled_tasks: 'read',

  // --- low-risk write (drafting into an unsent form) --------------------
  fill_input: 'low_risk_write',

  // --- external communication / outbound with the user's session -------
  submit_form: 'external_comms',
  draft_email: 'external_comms',
  call_mcp_tool: 'external_comms',
  call_webmcp_tool: 'external_comms',
  get_all_tab_contents: 'external_comms', // bulk cross-tab read — treat as sensitive per spec

  // --- persistence / record modification --------------------------------
  save_as_skill: 'record_modification',
  save_app_playbook: 'record_modification',
  schedule_task: 'record_modification',

  // --- destructive (irreversible, or arbitrary code) --------------------
  cancel_scheduled_task: 'destructive',
  run_javascript: 'destructive', // arbitrary code in the page — worst case
  press_keys: 'destructive', // keyboard input can submit/trigger
  click_at: 'destructive', // coordinate click can commit anything
  drag: 'destructive', // drag can reorder/drop
  click_element: 'external_comms', // a click can commit an outbound action
};

/**
 * Resolve a tool's action class: explicit table entry, else `read` for known
 * read-only tools, else the safe default `external_comms` (asks for approval).
 */
export function classifyTool(tool: string, readOnlyTools: ReadonlySet<string>): ActionClass {
  return TOOL_ACTION_CLASS[tool] ?? (readOnlyTools.has(tool) ? 'read' : 'external_comms');
}

/**
 * Approval binding (specification.md §12.4): a granted approval is only valid
 * until its `expiresAt`. A user clicking "approve" on a card that has been
 * sitting past the timeout must not authorize the action — the agent has to ask
 * again. Undefined `expiresAt` means "no expiry" (legacy/unbound approvals).
 */
export function isApprovalStillValid(expiresAt: number | undefined, now: number): boolean {
  return expiresAt === undefined || now < expiresAt;
}
