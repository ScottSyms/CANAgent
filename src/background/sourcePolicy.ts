import type { ToolDefinition } from './llmTypes';

export type SourcePolicy =
  | { mode: 'unrestricted' }
  | { mode: 'repo_only'; repos: string[]; webApproved: boolean };

// Tools that can acquire factual content outside the explicitly selected local
// repository. Output-only and planning tools remain available in repo-only mode.
export const EXTERNAL_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'search_web',
  'open_url',
  'navigate',
  'get_tab_content',
  'get_all_tab_contents',
  'read_tab_group',
  'read_app_content',
  'read_pdf',
  'read_office_document',
  'get_video_transcript',
  'search_known_sites',
  'sharepoint_search',
  'microsoft365_search',
  'calendar_search',
  'list_mcp_tools',
  'call_mcp_tool',
  'list_webmcp_tools',
  'call_webmcp_tool',
  'run_subtasks',
  'start_research_job',
]);

export function sourcePolicyForRepos(repos: string[]): SourcePolicy {
  const unique = [...new Set(repos.map((repo) => repo.trim()).filter(Boolean))];
  return unique.length > 0 ? { mode: 'repo_only', repos: unique, webApproved: false } : { mode: 'unrestricted' };
}

export function sourceToolAllowed(policy: SourcePolicy, toolName: string): boolean {
  if (policy.mode === 'unrestricted' || policy.webApproved) return true;
  return !EXTERNAL_SOURCE_TOOLS.has(toolName);
}

export function sourceRepositoryAllowed(policy: SourcePolicy, repo: string): boolean {
  return policy.mode !== 'repo_only' || policy.repos.includes(repo);
}

export function toolsForSourcePolicy(policy: SourcePolicy, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => {
    if (tool.function.name === 'request_web_fallback') return policy.mode === 'repo_only' && !policy.webApproved;
    return sourceToolAllowed(policy, tool.function.name);
  });
}

export function sourcePolicyPrompt(policy: SourcePolicy): string {
  if (policy.mode !== 'repo_only' || policy.webApproved) return '';
  return (
    `\n\nRepository-only source policy (enforced by the runtime): answer only from ${policy.repos.map((repo) => `"${repo}"`).join(', ')}. ` +
    'Do not use browser pages, web search, external services, MCP, or your own factual knowledge as evidence. ' +
    'Use the repository passages already attached to the user request; refine with search_repo/search_graph/global_search only if needed. ' +
    'If repository evidence is insufficient, call request_web_fallback with a plain-language reason. The user must approve before external tools become available. ' +
    'If approval is denied, state that the repository does not contain enough evidence.'
  );
}
