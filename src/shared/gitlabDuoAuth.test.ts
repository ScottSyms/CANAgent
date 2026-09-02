import { describe, expect, it } from 'vitest';
import {
  authorizeEndpoint,
  buildAiActionMutation,
  buildAiMessagesQuery,
  buildAuthUrl,
  buildTokenBody,
  DEFAULT_GITLAB_INSTANCE,
  graphqlEndpoint,
  tokenEndpoint,
} from './gitlabDuoAuth';

describe('endpoint builders', () => {
  it('default to gitlab.com', () => {
    expect(authorizeEndpoint('')).toBe(`${DEFAULT_GITLAB_INSTANCE}/oauth/authorize`);
    expect(tokenEndpoint('')).toBe(`${DEFAULT_GITLAB_INSTANCE}/oauth/token`);
    expect(graphqlEndpoint('')).toBe(`${DEFAULT_GITLAB_INSTANCE}/api/graphql`);
  });

  it('support a self-managed instance, trimming a trailing slash', () => {
    expect(authorizeEndpoint('https://gitlab.example.com/')).toBe('https://gitlab.example.com/oauth/authorize');
    expect(graphqlEndpoint('https://gitlab.example.com')).toBe('https://gitlab.example.com/api/graphql');
  });
});

describe('buildAuthUrl', () => {
  it('includes PKCE, state, and the requested scope', () => {
    const url = new URL(
      buildAuthUrl({
        instanceUrl: 'https://gitlab.example.com',
        clientId: 'client-1',
        redirectUri: 'https://ext.chromiumapp.org/cb',
        codeChallenge: 'challenge-value',
        state: 'state-value',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://gitlab.example.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('scope')).toContain('api');
  });
});

describe('buildTokenBody', () => {
  it('builds an authorization_code exchange', () => {
    const body = new URLSearchParams(
      buildTokenBody({ clientId: 'c1', redirectUri: 'https://ext.chromiumapp.org/cb', code: 'the-code', codeVerifier: 'the-verifier' }),
    );
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
  });

  it('prefers the refresh path when a refresh token is given', () => {
    const body = new URLSearchParams(
      buildTokenBody({ clientId: 'c1', redirectUri: 'https://ext.chromiumapp.org/cb', refreshToken: 'refresh-1' }),
    );
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });
});

describe('Duo Chat GraphQL builders', () => {
  it('builds the aiAction submit mutation', () => {
    const { query, variables } = buildAiActionMutation('hello', 'sub-1');
    expect(query).toContain('aiAction');
    expect(variables).toEqual({ content: 'hello', clientSubscriptionId: 'sub-1' });
  });

  it('builds the aiMessages poll query', () => {
    const { query, variables } = buildAiMessagesQuery(['req-1']);
    expect(query).toContain('aiMessages');
    expect(variables).toEqual({ requestIds: ['req-1'] });
  });
});
