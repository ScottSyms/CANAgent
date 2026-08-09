import { memo } from 'preact/compat';
import type { PlanStepStatus, PlanView } from '../shared/types';
import { useT } from './i18n';

const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  in_progress: '»',
  done: '✓',
  skipped: '–',
};

export const PlanPanel = memo(function PlanPanel({ plan }: { plan: PlanView | null }) {
  const t = useT();
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return (
    <div class="plan-panel">
      <div class="plan-header">
        {t('plan.title')} ({done}/{plan.steps.length})
      </div>
      <ul class="plan-list">
        {plan.steps.map((s, i) => (
          <li key={i} class={`plan-step plan-${s.status}`}>
            <span class="plan-icon">{STATUS_ICON[s.status]}</span>
            <span class="plan-text">{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});
