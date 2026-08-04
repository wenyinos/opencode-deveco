# opencode-deveco

English | **[简体中文](./README_zh.md)**

Use **DevEco Code** (Huawei HarmonyOS GLM models) from standard [opencode](https://opencode.ai),
logging in with your Huawei account.

> ⚠️ China site (`siteId=1`) Huawei accounts only, matching upstream DevEco Code.

---

## How it works (important)

opencode's **published binary does not load external plugins' auth hooks**, so we
can't inject DevEco's Bearer token through the plugin system. Instead this
project runs a **small local proxy** that opencode talks to like any OpenAI
endpoint:

```
opencode  ──►  http://127.0.0.1:17128/v2  (this proxy)
                     │  + injects Authorization: Bearer <devEco token>
                     │  + applies DevEco /no-stream URL rule
                     ▼
              https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2
```

The proxy handles: Huawei OAuth login, access-token caching & 30-min refresh,
header injection, and streaming/non-streaming forwarding. Verified end-to-end
against opencode `1.17.6`.

The opencode plugin (`src/plugin.ts`) is kept for forward-compatibility: on
opencode versions that *do* load plugin auth, its `auth.loader` takes over and
the proxy isn't needed. On current opencode, **the proxy is the live path**.

---

## Prerequisites

- [opencode](https://opencode.ai) installed
- Node 18+
- A Huawei account on the **China** site

---

## Setup

### 1. Build

```bash
git clone <this-repo> opencode-deveco
cd opencode-deveco
npm install
npm run build          # produces dist/
npm run test           # run tests
npm run lint           # check code style
```

### 2. Point opencode at the proxy

Add a `deveco` provider to your `opencode.json` whose `baseURL` is the local
proxy. The `apiKey` is a placeholder — the proxy injects the real token.

```jsonc
{
  "provider": {
    "deveco": {
      "name": "DevEco Code",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:17128/v2",
        "apiKey": "opencode-oauth-dummy-key"
      },
      "models": {
        "GLM-5.1": {
          "name": "GLM-5.1",
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": 170000, "output": 131072 },
          "modalities": { "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
```

> Tip: on opencode builds that load external plugin `config` hooks, also add
> `"opencode-deveco"` to the `plugin` array — it will start the proxy for you
> and inject the provider above automatically.

### 3. Start the proxy

The proxy listens on `127.0.0.1:17128` by default. Override with
`DEVECO_PROXY_PORT=<port>` (and update the `baseURL` in step 2 to match).

**Foreground** (best for first-run / debugging — logs print live to the terminal):

```bash
node dist/proxy.js
```

**Windows — hidden background process** (no taskbar window; logs → `proxy.log`):

```powershell
# from the project root
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
# stop it later:
powershell -ExecutionPolicy Bypass -File scripts\stop-windows.ps1
```

> For autostart on login: create a Task Scheduler task (or a shortcut in the
> Startup folder) that runs the `start-windows.ps1` script.

**Linux / macOS — background process:**

```bash
nohup node dist/proxy.js > proxy.log 2>&1 &
```

**Linux — systemd user service (autostart + auto-restart):**

```bash
mkdir -p ~/.config/systemd/user
cp scripts/opencode-deveco.service ~/.config/systemd/user/
# edit ExecStart / WorkingDirectory in the copied file to your install path
systemctl --user daemon-reload
systemctl --user enable --now opencode-deveco
journalctl --user -u opencode-deveco -f   # follow logs
```

> The systemd unit enables lingering-free autostart on login. For boot-time
> autostart (before login) run `loginctl enable-linger $USER`.

**macOS — launchd user agent (autostart + auto-restart):**

```bash
mkdir -p ~/Library/LaunchAgents
cp scripts/com.opencode-deveco.proxy.plist ~/Library/LaunchAgents/
# edit the node / project / log paths in the copied file
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opencode-deveco.proxy.plist
tail -f ~/Library/Logs/opencode-deveco.log   # follow logs
# stop: launchctl bootout gui/$(id -u)/com.opencode-deveco.proxy
```

> Keep it a LaunchAgent rather than a LaunchDaemon — agents run inside your
> logged-in GUI session, which is what lets the automatic browser login work.
> launchd starts with a bare `PATH` and never reads your shell profile, so the
> plist needs the absolute path to `node` (`which node`).

### 4. Log in

Open `http://127.0.0.1:17128/v2/login` **in a browser** — it redirects straight
to the Huawei OAuth page. It returns immediately (302) rather than holding the
connection open, so from a script you get the URL back instead:

```bash
curl http://127.0.0.1:17128/v2/login
# → {"login_url":"https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=10101&..."}
curl http://127.0.0.1:17128/v2/status   # poll until {"logged_in":true,...}
```

If you send a request while logged out, the proxy tries to open a browser for
you and answers that request with `401` plus the same login URL — complete the
sign-in, then retry. (Running as a background service with no desktop session,
the automatic open can't work; use the URL from the `401` or from `/v2/login`.)

#### Logging in on a headless server

Huawei sends the browser back to `http://127.0.0.1:<port>/callback`, and that
listener binds loopback only — so the browser and the listener need a shared
localhost. An SSH tunnel gives them one:

```bash
# from your desktop; keep it open for the whole login
ssh -L 10101:127.0.0.1:10101 -L 17128:127.0.0.1:17128 user@server
```

Then open `http://127.0.0.1:17128/v2/login` in your **desktop** browser and sign
in; the callback travels down the tunnel and the credentials land on the server.

> The callback port is not always 10101 — it falls back to 34567-34570 when
> taken. Forward whichever port the login URL's `port=` names.

Both ports bind loopback and the proxy has no authentication of its own, so a
tunnel is the intended way in — don't expose the port instead.

---

## Verify

```bash
opencode models                         # should list deveco/GLM-5.1
opencode run "say hi" -m deveco/GLM-5.1 # real request through the proxy
```

> The model id is **`GLM-5.1`** (what DevEco's backend actually advertises). If
> you see `ProviderModelNotFoundError` with `suggestions: ["GLM-5.1"]`, you used
> the old `glm-5` name — switch to `GLM-5.1`.

---

## Proxy endpoints

| Method & path | Purpose |
|---|---|
| `POST /v2/chat/completions` | OpenAI-compatible — forwarded to DevEco (non-streaming by default; an explicit `"stream": true` opts into SSE) |
| `POST /anthropic/v1/messages` | Anthropic Messages API — auto-translated to/from OpenAI |
| `GET  /v2/models` | DevEco model list (dynamic, static fallback; 1-hour cache TTL) |
| `GET  /v2/login` | 302 → Huawei OAuth page (returns `{login_url}` to non-redirecting clients) |
| `GET  /v2/status` | `{ logged_in, user, expires_in_ms }` |
| `GET  /v2/logout` | clear stored credentials |

> All endpoints also work without the `/v2` prefix (e.g. `GET /status`).

---

## Claude Code integration

The proxy also speaks the **Anthropic Messages API** (`POST /anthropic/v1/messages`),
auto-translating requests to OpenAI Chat Completions format for DevEco. This
lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code) use DevEco
models directly.

Set these environment variables before launching Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:17128/anthropic
export ANTHROPIC_API_KEY=opencode-oauth-dummy-key
export ANTHROPIC_MODEL=GLM-5.1
```

Then start Claude Code normally. Streaming, tool use, thinking blocks and image
content are all supported.

---

## Logs & observability

The proxy logs to stdout (info) and stderr (warn/error) — the terminal when run
in the foreground, or wherever you redirected it. Each request produces a pair of
lines:

```
[2026-06-14T16:53:24.999Z] [INFO] -> POST stream model=GLM-5.1
[2026-06-14T16:53:27.150Z] [INFO] <- 200 2151ms in=2677 out=7 model=GLM-5.1 (backend: GLM5_1_W4A8-1.0.0)
```

`in=`/`out=` are prompt and completion tokens, and the trailing `backend:` is the
DevEco model that actually served the request. Session events (token refresh,
`401` retries, login) are logged too.

Verbosity via env: `DEVECO_LOG_LEVEL=debug|info|warn|error` (default `info`).

> opencode's own logs (`~/.local/share/opencode/log/`) only show the request
> hitting `http://127.0.0.1:17128/v2` — they don't see DevEco-side details. The
> proxy log is where the real DevEco call trace lives.

---

## Token storage & refresh

| Credential | Location | Notes |
|---|---|---|
| `accessToken` (30 min) | in-memory in the proxy | auto-refreshed on the next request |
| `jwtToken` (long-lived refresh credential) | `~/.config/opencode/opencode-deveco/jwt.json` | plain JSON, `0600`; override dir with `XDG_CONFIG_HOME`/`OPENCODE_CONFIG_DIR` |

### Do I need to log in again when the token expires / after a reboot?

**No**, in almost all cases — browser login is only needed when the long-lived
`jwtToken` itself expires (days/weeks). Three cases:

| Scenario | Re-login? | What happens |
|---|---|---|
| `accessToken` expires (every 30 min) | ❌ No | The proxy silently refreshes it with the stored jwtToken — no browser, no action. A second safety net: if DevEco returns `401` mid-request, the proxy refreshes once and retries. |
| Machine / proxy restart | ❌ No | On startup the proxy reads `jwt.json` and refreshes to restore the session headlessly (`GET /v2/status` → `logged_in:true`). You only need to **restart the proxy process** (`node dist/proxy.js`); consider adding it to your OS autostart. |
| `jwtToken` also expires | ⚠️ Yes | When the long-lived jwtToken is no longer valid server-side, refresh fails. The next request then auto-triggers browser login, or run `curl http://127.0.0.1:17128/v2/login` manually. |

On startup the proxy tries to restore a session from the stored jwtToken
(refresh-on-boot). If that fails it waits for the next request to trigger
browser login.

---

## Limitations

- **China site only.** Non-CN `siteId` values are rejected.
- **Proxy must be running** for opencode to reach DevEco (current opencode
  doesn't load external plugin auth). Run it as a background service / startup
  task.
- **Plain-JSON jwtToken storage** (no encryption). Swap `JsonTokenStore` for an
  encrypted impl if needed — only `token-store.ts` changes.
- **One proxy instance per account.** A second process sharing the same
  `jwt.json` cannot refresh — DevEco appears to invalidate the previous refresh
  when another one succeeds — and it will fall back to a browser login.
- **Default port 17128** is not configurable via opencode; change it via
  `DEVECO_PROXY_PORT` and update the provider `baseURL`.

---

## Recent improvements

Long Claude Code sessions used to break after a few rounds; the fixes for that
and for login are the recent bulk of the work. `git log` has the reasoning
behind each.

- **Idle-based upstream timeout** — a turn is cut only after DevEco goes *silent*
  for 120s, instead of a 60s cap on its total length that killed long
  conversations. Interrupted streams now emit a real Anthropic `error` event
  rather than truncating.
- **Forced tool choice works** — `tool_choice: {"type":"tool"}` used to fail the
  whole request; DevEco only accepts the enum form.
- **`max_tokens` is honoured** — it was silently dropped on the Anthropic path.
- **Stable Chat-Id per conversation**, and the queue slot is released via
  `exitSessionQueue` when a turn ends.
- **Non-blocking login** — `/v2/login` redirects immediately, and requests made
  while logged out fail fast with the login URL instead of hanging.
- **Graceful shutdown**, **hourly model-list refresh**, **`fetch` everywhere**
  (the custom `HttpClient` is gone), **lint + tests**, and an optional `/v2`
  prefix on every endpoint.

---

## Troubleshooting

- **`opencode run ... -m deveco/glm-5` fails with connection refused** → the
  proxy isn't running. Start it (`node dist/proxy.js`).
- **First request opens a browser and returns `401`** → that's expected when
  logged out: the proxy starts the login in the background rather than making
  you wait for it. Finish the Huawei login and retry; the next 30 minutes are
  headless.
- **`401` after a while** → access token expired and refresh failed (jwtToken
  no longer valid server-side). Hit `/v2/login` again.
- **A long turn ends with `Upstream stream ended early`** → DevEco went quiet for
  120s mid-answer. Retry; if it repeats, the conversation is likely too large for
  the model's context and needs compacting.
- **`opencode models` shows no deveco models** → check the `provider.deveco`
  entry exists in `opencode.json` (this is config-driven, not plugin-driven).
- **Non-streaming requests time out** → DevEco's `/no-stream` endpoint can be
  slow; send `"stream": true` to opt back into streaming. The proxy defaults
  OpenAI requests to non-streaming (only an explicit `stream: true` enables
  SSE); opencode always sends `stream: true`, so it is unaffected.

---

## Project layout

| File | Purpose |
|---|---|
| [`src/proxy.ts`](./src/proxy.ts) | local proxy server (the live auth+forward path) |
| [`src/plugin.ts`](./src/plugin.ts) | opencode plugin (proxy lifecycle + forward-compat auth hook) |
| [`src/anthropic-transform.ts`](./src/anthropic-transform.ts) | Anthropic Messages ↔ OpenAI Chat protocol translation |
| [`src/auth-login.ts`](./src/auth-login.ts) | `LocalAuthServer` + `LoginService` (Huawei OAuth flow) |
| [`src/token-store.ts`](./src/token-store.ts) | jwtToken JSON persistence |
| [`src/models.ts`](./src/models.ts) | dynamic model list fetch + static fallback (1-hour cache TTL) |
| [`src/config.ts`](./src/config.ts) | constants, defaults, endpoints |

See [`DevEco-OpenCode-Plugin-Plan.md`](./DevEco-OpenCode-Plugin-Plan.md) for the
original design notes (written before the proxy pivot).

---

## License

MIT
