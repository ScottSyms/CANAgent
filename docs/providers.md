# Subscription-backed model connections

Last verified against official provider documentation: 2026-08-23.

CANChat uses subscription quota only through provider-documented integration
surfaces. It does not scrape chat websites, extract cookies, import another
application's credentials, reuse another application's OAuth identity, or call
private inference endpoints.

## Status

| Provider | Decision | Authentication | Billing or quota source |
|---|---|---|---|
| ChatGPT / Codex | `local_companion` | Official Codex login, owned by the local Codex App Server | ChatGPT/Codex plan limits and workspace policy |
| GitHub Copilot | `local_companion` | CANChat-owned GitHub OAuth App Device Flow | Copilot subscription and GitHub AI Credits |
| GitLab Duo | `blocked` | OAuth is documented, but no CANChat inference transport is verified | Not available |
| xAI / SuperGrok | `api_key_only` | User-created xAI API key | Separately billed xAI API usage |

`local_companion` means a provider's official Node/CLI runtime must execute on
the user's computer because a Manifest V3 service worker cannot spawn it.
`api_key_only` means a consumer subscription is not used. `blocked` means the
code intentionally refuses the connection rather than imitate an official
client or rely on an unverified API.

## ChatGPT / Codex

OpenAI documents the Codex SDK and Codex App Server for embedding Codex in
other products. It also documents ChatGPT subscription authentication for
Codex. OpenAI does not document an independently registered browser-extension
OAuth client that can exchange ChatGPT subscription credentials for raw model
API access, so CANChat does not implement direct OpenAI OAuth.

The companion at `companion/codex-host/` starts the official `codex app-server`
over stdio. App Server owns login, refresh, workspace policy, model discovery,
and upstream transport. CANChat receives only allowlisted account metadata,
model metadata, and generated text; no access or refresh token crosses native
messaging.

### Install

1. Follow `companion/codex-host/install.md`.
2. Run `npx codex login` from that directory and complete OpenAI's login.
3. In Workspace -> Models -> Subscription Providers, connect ChatGPT / Codex.
4. Select `ChatGPT / Codex local companion` as the primary connection and pick
   a model returned by App Server.

Each request uses a fresh read-only thread, restricted to the companion
directory, with network and ambient project tools unavailable. The thread is
deleted after completion. Cancellation uses App Server `turn/interrupt`.

The companion reads App Server's official primary rate-limit window and shows
its usage percentage and reset time. It does not infer limits or expose raw
workspace-credit records. API-key use through `https://api.openai.com/v1`
remains supported but is separately billed.
Disconnecting disables the connection in CANChat. Run `npx codex logout` from
the companion directory if the official local Codex session should also be
revoked.

For enterprise deployment, contact OpenAI about registering CANChat's stable
App Server `clientInfo` name for compliance-log attribution.

Official references:

- <https://developers.openai.com/codex/auth/>
- <https://developers.openai.com/codex/sdk/>
- <https://developers.openai.com/codex/app-server/>
- <https://developers.openai.com/codex/non-interactive-mode/>

## GitHub Copilot

GitHub explicitly documents OAuth App user tokens as an authentication method
for the official Copilot SDK. CANChat uses its own OAuth App client ID and the
documented Device Authorization Grant. It never uses GitHub's, Copilot CLI's,
or another application's client ID.

Inference runs through `@github/copilot-sdk` in
`companion/github-copilot-host/`. The SDK starts in `mode: "empty"`, with
`useLoggedInUser: false`, an explicit per-request OAuth token, and no ambient
tools. Model restrictions, organization policies, entitlement failures, rate
limits, and AI-credit limits are enforced by GitHub and surfaced as errors.

### Register OAuth

1. Create a GitHub OAuth App owned by CANChat's distributor or by the user.
2. Enable Device Flow in the app settings.
3. Enter its public Client ID in Workspace -> Models -> Subscription Providers.
4. Do not configure or distribute a client secret.
5. Connect, open `https://github.com/login/device`, and enter the displayed
   short-lived code.
6. Follow `companion/github-copilot-host/install.md` to install the native host.

No OAuth scope is requested by default. If expiring OAuth tokens are enabled,
GitHub returns rotating access and refresh tokens; CANChat deduplicates refresh
requests and atomically stores the new pair.

GitHub does not provide a general personal Copilot quota endpoint for this
OAuth token. Organization-owner billing endpoints require broader organization
permissions and are not requested. Disconnect clears CANChat's local token.
Users can revoke it remotely under GitHub Settings -> Applications ->
Authorized OAuth Apps.

Official references:

- <https://github.com/github/copilot-sdk>
- <https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/authenticate.md>
- <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>

## GitLab Duo

GitLab documents Authorization Code with PKCE and its normal REST/GraphQL API.
That proves a third party can authenticate to GitLab; it does not by itself
prove that a third party may use a Duo subscription as a generic model API.

The previous CANChat experiment used public-schema `aiAction` and `aiMessages`
GraphQL fields. It was covered only by HTTP mocks and was never exercised with
a licensed tenant. Current GitLab Agent Platform documentation describes a
multi-token chain and official GitLab UI, IDE, and Duo CLI surfaces. Because no
Duo-enabled test tenant is available and no independent inference contract was
confirmed, that experiment is disabled and the provider reports `blocked`.

GitLab's official Duo CLI offers headless mode, but headless mode automatically
approves all tools. CANChat does not wrap it as a model companion without a
cross-platform sandbox and explicit tool isolation.

Activation requires both a provider-documented third-party inference contract
and an opt-in live test against a licensed GitLab.com or self-managed tenant.
The pure PKCE and GraphQL builders remain unit-tested as dormant framework code
but are not reachable through provider management or model routing.

Official references:

- <https://docs.gitlab.com/api/oauth2/>
- <https://docs.gitlab.com/user/duo_agent_platform/>
- <https://docs.gitlab.com/user/duo_agent_platform/authentication/>
- <https://docs.gitlab.com/user/gitlab_duo_cli/>

## xAI / SuperGrok

xAI's developer documentation requires an API key created in xAI Console.
Models are available through the documented Responses and Chat Completions
APIs at `https://api.x.ai/v1`. API usage requires API credits and is separate
from SuperGrok or X Premium+.

xAI does not document third-party SuperGrok OAuth client registration or an API
that applies SuperGrok quota to external applications. CANChat therefore does
not implement consumer OAuth and does not call `accounts.x.ai` subscription
endpoints. Configure an xAI API key using the normal endpoint connection.

Official references:

- <https://docs.x.ai/developers/quickstart>
- <https://docs.x.ai/developers/rest-api-reference/inference>
- <https://docs.x.ai/developers/models>

## Architecture

`SubscriptionProvider` in `src/background/providers/types.ts` owns connection,
account, models, response streaming, cancellation, refresh, and optional quota
status. `registry.ts` supplies decisions and capability flags to both the UI
and model router. The existing protocol adapters remain the default endpoint
and API-key path.

The main `complete()` gateway checks `Settings.subscriptionProvider`. When it
is absent, behavior is unchanged. When selected, it checks connection and
input capabilities before delegating to the provider. Blocked providers cannot
be selected in the model UI.

The current local companions intentionally advertise `tools: false`: their
official runtimes run without ambient tools, and CANChat has not yet enabled an
audited bidirectional custom-tool bridge. Subscription models can provide text
answers, but tasks requiring CANChat browser tool calls should continue using a
supported endpoint protocol.

## Security and privacy

- Provider networking and native messaging run only in the service worker.
- Provider operations are accepted only from extension pages, never content
  scripts, injected page scripts, or webpage JavaScript.
- Runtime provider IDs are allowlisted; callers cannot choose URLs, headers,
  scopes, or arbitrary native operations.
- Codex credentials remain entirely inside the official local runtime.
- GitHub OAuth tokens use `chrome.storage.local`, never sync storage.
- Token records are validated and versioned; malformed records are removed.
- GitHub refresh is single-flight and supports refresh-token rotation.
- OAuth redirect helpers use cryptographic PKCE/state, five-minute expiry, and
  exact callback origin/path validation.
- Native requests have size limits, cryptographic IDs, timeouts, cancellation,
  response correlation, and malformed-message rejection.
- Provider errors pass through centralized credential redaction.
- No tokens, authorization codes, or account responses are logged, exported,
  included in analytics, or returned to content scripts.

### Remaining local-storage limitation

GitHub's token is persisted by Chrome in extension-local storage. Chrome
isolates this area from websites and other extensions, but it is not encrypted
against an attacker who can read the user's browser profile. The optional
CANChat vault does not currently wrap provider-token records. This matches the
existing local-only extension threat model but should not be treated as an OS
keychain. Codex avoids this limitation by keeping credentials in its own
configured credential store.

## Permissions

- `identity`: GitHub Device Flow and future documented PKCE flows.
- `nativeMessaging`: official Codex and Copilot SDK companions.
- No provider-specific host permission was added. The pre-existing
  `<all_urls>` permission is required by CANChat's browser tool environment and
  already covers documented API calls.
- CSP remains `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

## Adding a provider

1. Record dated official documentation for authentication, inference, models,
   quota, revocation, policy, CORS, and billing semantics.
2. Stop with `blocked` or `api_key_only` if independent registration and
   subscription inference are not explicitly supported.
3. Add pure auth/normalization helpers and mocked tests without live secrets.
4. Implement `SubscriptionProvider`, using background-only networking and the
   shared token, redaction, timeout, and native-message boundaries.
5. Add the descriptor and provider ID; render setup through capability data.
6. Add opt-in live tests for final activation. Mocked success alone is not
   sufficient to display subscription inference as supported.
