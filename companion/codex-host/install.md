# OpenAI Codex local companion - install

This optional companion lets the extension use the official Codex app-server.
Codex owns authentication and refreshes its own credentials. The companion
does not read Codex auth files, accept tokens from the extension, or return
tokens to it.

Each completion runs in a fresh read-only thread with network access disabled
and filesystem reads restricted to this companion directory. The thread is
deleted when the turn finishes. The host also exposes the app-server's stable
model-list and redacted account-status surfaces, and supports streaming and
cancellation.

## 1. Install Codex

```bash
cd companion/codex-host
npm install
```

This installs OpenAI's official `@openai/codex` package locally. Node 18 or
later is required.

## 2. Sign in with the official CLI

```bash
npx codex login
```

Complete the OpenAI-managed login flow. Do not put an API key or token in the
native-messaging manifest. You can check the official CLI independently with
`npx codex`.

## 3. Get the extension ID

Load the unpacked extension from `dist/` using `chrome://extensions`, with
Developer mode enabled, then copy the 32-letter ID shown on its card.

## 4. Register the native-messaging host

Copy `com.canchat.codex_host.json.template` to
`com.canchat.codex_host.json`, then:

- Set `path` to the absolute path of `host.mjs`. On Windows, point it at a
  `.bat` wrapper that runs `node host.mjs %*` because Windows cannot execute
  `.mjs` files directly.
- Replace the extension ID in `allowed_origins`.

Place the completed manifest where Chrome looks for native-messaging hosts:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.canchat.codex_host.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.canchat.codex_host.json` |
| Windows | Set the default value of `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.canchat.codex_host` to the absolute path of the JSON file |

On macOS or Linux, ensure the host is executable with `chmod +x host.mjs`.
Chrome starts and stops it on demand; there is no companion daemon to run.

## Protocol

The host accepts only `listModels`, `accountStatus`, `quota`, `complete`, and `abort`.
Native messages are limited to 1 MiB, prompt text to 256 KiB, and response text
to 512 KiB. Errors crossing the native boundary are reduced to safe error
codes and do not contain paths, command output, environment values, or tokens.

## Uninstall

Delete the native-messaging manifest (and the Windows registry key, if used),
then optionally remove this directory.
