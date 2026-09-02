# GitHub Copilot local companion — install

This is an optional, reference companion process. It is only needed for
**chatting through Copilot itself**; connecting your GitHub account and
seeing your GitHub profile in the Providers screen work without it. See
[`docs/providers.md`](../../docs/providers.md) for why this exists (GitHub's
officially-supported way to call Copilot is its SDK/CLI, which needs a
subprocess — something a Chrome extension's service worker cannot spawn).

## 1. Install the Node dependency

```bash
cd companion/github-copilot-host
npm install
```

This pulls in `@github/copilot-sdk` (GitHub's own, MIT-licensed SDK), which
in turn manages the `copilot` CLI. Node 18+ required.

## 2. Get your extension's ID

Load the unpacked extension (`chrome://extensions` → Developer mode → "Load
unpacked" → select `dist/`), then copy the ID shown on its card (a 32-letter
string).

## 3. Register the native-messaging host

Copy `com.canchat.github_copilot_host.json.template` to
`com.canchat.github_copilot_host.json`, then:

- Set `"path"` to the **absolute** path of `host.mjs` in this directory (on
  Windows, point it at a `.bat` wrapper that runs `node host.mjs %*`, since
  Windows can't execute `.mjs` directly).
- Set `"allowed_origins"` to `["chrome-extension://<your-extension-id>/"]`.

Then place that file where Chrome looks for native-messaging hosts:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.canchat.github_copilot_host.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.canchat.github_copilot_host.json` |
| Windows | Add a registry key `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.canchat.github_copilot_host` whose default value is the **absolute path** to the JSON file |

Make sure `host.mjs` is executable (`chmod +x host.mjs` on macOS/Linux — already
set in this repo checkout, but re-apply if you copied the file elsewhere).

## 4. Connect

In the extension's Models → Providers screen, connect GitHub Copilot as
usual. Once connected, the extension will reach this host automatically the
next time it needs to send a completion or list models — no separate
"start the companion" step; Chrome launches it on demand per the manifest
above and stops it when the connection is idle.

## Uninstalling

Delete the native-messaging manifest file (and registry key, on Windows) from
the location in step 3, and optionally delete this directory.
