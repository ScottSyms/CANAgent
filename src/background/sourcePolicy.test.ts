import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from './llmTypes';
import { sourcePolicyForRepos, sourceRepositoryAllowed, sourceToolAllowed, toolsForSourcePolicy } from './sourcePolicy';

const tool = (name: string): ToolDefinition => ({ type: 'function', function: { name, description: '', parameters: {} } });

describe('repository source policy', () => {
  it('blocks external acquisition tools but keeps repository and output tools', () => {
    const policy = sourcePolicyForRepos(['Collective agreements']);
    expect(sourceToolAllowed(policy, 'search_web')).toBe(false);
    expect(sourceToolAllowed(policy, 'run_subtasks')).toBe(false);
    expect(sourceToolAllowed(policy, 'search_repo')).toBe(true);
    expect(sourceToolAllowed(policy, 'create_file')).toBe(true);
    expect(sourceRepositoryAllowed(policy, 'Collective agreements')).toBe(true);
    expect(sourceRepositoryAllowed(policy, 'Other repo')).toBe(false);
    expect(
      toolsForSourcePolicy(policy, [tool('search_web'), tool('search_repo'), tool('request_web_fallback')])
        .map((item) => item.function.name),
    ).toEqual(['search_repo', 'request_web_fallback']);
  });

  it('allows external tools only after explicit approval', () => {
    const policy = sourcePolicyForRepos(['r']);
    if (policy.mode === 'repo_only') policy.webApproved = true;
    expect(sourceToolAllowed(policy, 'search_web')).toBe(true);
    expect(
      toolsForSourcePolicy(policy, [tool('search_web'), tool('request_web_fallback')]).map((item) => item.function.name),
    ).toEqual(['search_web']);
  });

  it('leaves ordinary turns unrestricted', () => {
    expect(sourceToolAllowed(sourcePolicyForRepos([]), 'search_web')).toBe(true);
  });
});
