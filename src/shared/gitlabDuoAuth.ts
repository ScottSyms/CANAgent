// =============================================================================
// Pure helpers for GitLab's standard OAuth 2.0 identity provider
// (https://docs.gitlab.com/api/oauth2/) used to reach GitLab Duo. This is
// GitLab's own general-purpose, publicly documented OAuth mechanism — any
// GitLab user (or a self-managed instance admin) can register an
// "Application" under /-/user_settings/applications (or, for GitLab.com, the
// CANChat-owned Application registered per docs/providers.md) and grant a
// third-party client Authorization Code + PKCE access. It is NOT the
// composite-identity `ai_workflows`/`mcp` OAuth surface GitLab's own Duo Agent
// Platform orchestration uses internally for external agents — that surface
// is not a general third-party registration path and is intentionally not
// used here.
//
// No chrome.*/network here (unit-testable); background/providers/gitlabDuo.ts
// does the interactive launch + token storage + Duo Chat GraphQL calls.
// =============================================================================

export const DEFAULT_GITLAB_INSTANCE = 'https://gitlab.com';

/**
 * GitLab does not (as of this writing) publish a narrower "AI features only"
 * scope for user-created OAuth Applications — only the composite-identity
 * scopes (`ai_workflows`, `mcp`) exist, and those are scoped to GitLab's own
 * Duo Agent Platform orchestration, not general third-party OAuth clients.
 * `api` is therefore the narrowest scope that reaches the Duo Chat GraphQL
 * mutation; this is broader than ideal and is called out in docs/providers.md.
 */
export const DEFAULT_GITLAB_SCOPE = 'api read_user';

function normalizeInstance(instanceUrl: string): string {
  return (instanceUrl || DEFAULT_GITLAB_INSTANCE).trim().replace(/\/+$/, '');
}

export function authorizeEndpoint(instanceUrl: string): string {
  return `${normalizeInstance(instanceUrl)}/oauth/authorize`;
}

export function tokenEndpoint(instanceUrl: string): string {
  return `${normalizeInstance(instanceUrl)}/oauth/token`;
}

export function graphqlEndpoint(instanceUrl: string): string {
  return `${normalizeInstance(instanceUrl)}/api/graphql`;
}

export interface AuthUrlParams {
  instanceUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
}

export function buildAuthUrl(p: AuthUrlParams): string {
  const u = new URL(authorizeEndpoint(p.instanceUrl));
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', p.scope ?? DEFAULT_GITLAB_SCOPE);
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export function buildTokenBody(args: {
  clientId: string;
  redirectUri: string;
  code?: string;
  codeVerifier?: string;
  refreshToken?: string;
}): string {
  const b = new URLSearchParams();
  b.set('client_id', args.clientId);
  if (args.refreshToken) {
    b.set('grant_type', 'refresh_token');
    b.set('refresh_token', args.refreshToken);
  } else {
    b.set('grant_type', 'authorization_code');
    b.set('code', args.code ?? '');
    b.set('redirect_uri', args.redirectUri);
    b.set('code_verifier', args.codeVerifier ?? '');
  }
  return b.toString();
}

/**
 * Duo Chat's request/response GraphQL shapes (`Mutation.aiAction`,
 * `AiMessageType` on the `aiMessages` connection) per GitLab's public GraphQL
 * schema (docs.gitlab.com/api/graphql/reference). GitLab exposes these as a
 * fire-and-poll pair rather than a single request/response: `aiAction` only
 * *submits* the prompt and returns a `requestId`; the actual reply is
 * retrieved by polling `aiMessages(requestIds: [...])` until a message with a
 * matching `requestId` and role ASSISTANT appears. There is no token-level
 * streaming through this path (GitLab's own web/IDE clients use an
 * ActionCable websocket subscription for that, which this module does not
 * implement) — see providers/gitlabDuo.ts for why, and docs/providers.md for
 * the "verify against your instance" caveat this entails.
 */
export function buildAiActionMutation(content: string, clientSubscriptionId: string): { query: string; variables: Record<string, unknown> } {
  return {
    query: `mutation($content: String!, $clientSubscriptionId: String!) {
      aiAction(input: { chat: { content: $content, clientSubscriptionId: $clientSubscriptionId } }) {
        requestId
        errors
      }
    }`,
    variables: { content, clientSubscriptionId },
  };
}

export function buildAiMessagesQuery(requestIds: string[]): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query($requestIds: [String!]) {
      aiMessages(requestIds: $requestIds, first: 20) {
        nodes { requestId role content errors timestamp }
      }
    }`,
    variables: { requestIds },
  };
}

export const CURRENT_USER_QUERY = `query { currentUser { username name avatarUrl } }`;
