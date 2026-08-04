# opencode-deveco

**[English](./README.md)** | 简体中文

在普通 [opencode](https://opencode.ai) 中使用 **DevEco Code**（华为 HarmonyOS GLM 系列模型），用华为账号登录。

> ⚠️ 仅支持中国大陆站点（`siteId=1`）华为账号，与 DevEco Code 上游一致。

---

## 工作原理（重要）

opencode 的**发布二进制不加载外部插件的 auth hooks**，所以无法通过插件系统注入 DevEco 的 Bearer token。本项目改用一个**本地小代理**：opencode 把它当作普通 OpenAI 端点来访问。

```
opencode  ──►  http://127.0.0.1:17128/v2  （本代理）
                     │  + 注入 Authorization: Bearer <devEco token>
                     │  + 应用 DevEco /no-stream URL 规则
                     ▼
              https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2
```

代理负责：华为 OAuth 登录、access token 缓存与 30 分钟刷新、请求头注入、流式/非流式转发。已在 opencode `1.17.6` 上端到端验证通过。

opencode 插件（`src/plugin.ts`）保留作前向兼容：在**会**加载插件 auth 的 opencode 版本上，它的 `auth.loader` 会接管，代理就不需要了。在当前 opencode 上，**代理是真正的生效路径**。

---

## 前置条件

- 已安装 [opencode](https://opencode.ai)
- Node 18+
- **中国大陆**站点的华为账号

---

## 安装步骤

### 1. 构建

```bash
git clone <this-repo> opencode-deveco
cd opencode-deveco
npm install
npm run build          # 生成 dist/
npm run test           # 运行测试
npm run lint           # 检查代码风格
```

### 2. 让 opencode 指向代理

在 `opencode.json` 里加一个 `deveco` provider，`baseURL` 指向本地代理。`apiKey` 是占位符 —— 真实 token 由代理注入。

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

> 小贴士：如果你的 opencode 构建会加载外部插件的 `config` hook，把 `"opencode-deveco"` 加到 `plugin` 数组里即可 —— 它会自动启动代理并注入上面的 provider 配置。

### 3. 启动代理

代理默认监听 `127.0.0.1:17128`。用 `DEVECO_PROXY_PORT=<端口>` 覆盖（并同步修改第 2 步的 `baseURL`）。

**前台运行**（首次运行 / 调试首选 —— 日志实时打印到终端）：

```bash
node dist/proxy.js
```

**Windows —— 隐藏窗口后台进程**（无任务栏窗口；日志写入 `proxy.log`）：

```powershell
# 在项目根目录执行
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
# 停止：
powershell -ExecutionPolicy Bypass -File scripts\stop-windows.ps1
```

> 开机自启：用任务计划程序（或在"启动"文件夹放一个快捷方式）运行 `start-windows.ps1`。

**Linux / macOS —— 后台进程：**

```bash
nohup node dist/proxy.js > proxy.log 2>&1 &
```

**Linux —— systemd 用户服务（自启 + 自动重启）：**

```bash
mkdir -p ~/.config/systemd/user
cp scripts/opencode-deveco.service ~/.config/systemd/user/
# 编辑复制后的文件里的 ExecStart / WorkingDirectory 为你的实际安装路径
systemctl --user daemon-reload
systemctl --user enable --now opencode-deveco
journalctl --user -u opencode-deveco -f   # 实时看日志
```

> 这个 systemd unit 在用户登录时自启。要实现开机自启（登录前就启动）运行 `loginctl enable-linger $USER`。

**macOS —— launchd 用户代理（自启 + 自动重启）：**

```bash
mkdir -p ~/Library/LaunchAgents
cp scripts/com.opencode-deveco.proxy.plist ~/Library/LaunchAgents/
# 编辑复制后的文件里的 node / 项目 / 日志路径
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opencode-deveco.proxy.plist
tail -f ~/Library/Logs/opencode-deveco.log   # 实时看日志
# 停止：launchctl bootout gui/$(id -u)/com.opencode-deveco.proxy
```

> 必须用 LaunchAgent 而不是 LaunchDaemon —— agent 跑在你已登录的图形会话里，
> 自动打开浏览器登录才能生效。launchd 不读 shell 配置且 `PATH` 极简，
> 所以 plist 里要写 `node` 的绝对路径（用 `which node` 查）。

### 4. 登录

**用浏览器**打开 `http://127.0.0.1:17128/v2/login`，会直接 302 跳到华为 OAuth 页面。
该端点立即返回、不再挂住连接等回调，所以脚本调用拿到的是登录 URL：

```bash
curl http://127.0.0.1:17128/v2/login
# → {"login_url":"https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=10101&..."}
curl http://127.0.0.1:17128/v2/status   # 轮询直到 {"logged_in":true,...}
```

未登录时发请求，代理会尝试替你打开浏览器，并给这次请求返回 `401` + 同一个登录 URL —
登录完成后重试即可。（作为后台服务运行且没有桌面会话时，自动打开无法生效，
用 `401` 或 `/v2/login` 返回的 URL 手动登录。）

#### 在无头服务器上登录

华为会把浏览器重定向回 `http://127.0.0.1:<端口>/callback`，而这个监听只绑 loopback ——
浏览器和它必须共享同一个 localhost。用 SSH 隧道把两者接起来：

```bash
# 在桌面机器上执行，整个登录过程保持会话开着
ssh -L 10101:127.0.0.1:10101 -L 17128:127.0.0.1:17128 user@server
```

然后用**桌面机器的浏览器**打开 `http://127.0.0.1:17128/v2/login` 完成登录，回调会经隧道
送达服务器，凭证落在服务器上。

> 回调端口不一定是 10101 —— 被占用时会依次退到 34567-34570。按登录 URL 里 `port=`
> 给出的端口转发。

两个端口都只绑 loopback，代理自身也不做任何鉴权，所以走隧道是有意为之的访问方式，不要
直接把端口暴露出去。

---

## 验证

```bash
opencode models                           # 应能看到 deveco/GLM-5.1
opencode run "say hi" -m deveco/GLM-5.1   # 通过代理发真实请求
```

> 模型 id 是 **`GLM-5.1`**（DevEco 后端实际下发的名字）。如果看到
> `ProviderModelNotFoundError` 且 `suggestions: ["GLM-5.1"]`，说明你用了老的
> `glm-5` 名字 —— 改成 `GLM-5.1` 即可。

---

## 代理端点

| 方法 & 路径 | 用途 |
|---|---|
| `POST /v2/chat/completions` | OpenAI 兼容 — 转发到 DevEco（默认非流式；显式 `"stream": true` 才走 SSE 流式） |
| `POST /anthropic/v1/messages` | Anthropic Messages API — 自动转换为 OpenAI 格式 |
| `GET  /v2/models` | DevEco 模型列表（动态获取，失败回退静态；1 小时缓存 TTL） |
| `GET  /v2/login` | 302 跳转到华为 OAuth 页面（不跟随重定向的客户端会拿到 `{login_url}`） |
| `GET  /v2/status` | `{ logged_in, user, expires_in_ms }` |
| `GET  /v2/logout` | 清除已存凭证 |

> 所有端点均可省略 `/v2` 前缀（如 `GET /status`）。

---

## Claude Code 集成

代理同时支持 **Anthropic Messages API**（`POST /anthropic/v1/messages`），自动将请求转换为 OpenAI Chat Completions 格式。这让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 可以直接使用 DevEco 模型。

启动 Claude Code 前设置以下环境变量：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:17128/anthropic
export ANTHROPIC_API_KEY=opencode-oauth-dummy-key
export ANTHROPIC_MODEL=GLM-5.1
```

然后正常启动 Claude Code 即可。流式传输、工具调用、thinking 块和图片内容都支持。

---

## 日志与可观测性

代理把日志打到 stdout（info）和 stderr（warn/error）—— 前台运行就在终端，后台就在你重定向的文件里。每个请求产生一对日志：

```
[2026-06-14T16:53:24.999Z] [INFO] -> POST stream model=GLM-5.1
[2026-06-14T16:53:27.150Z] [INFO] <- 200 2151ms in=2677 out=7 model=GLM-5.1 (backend: GLM5_1_W4A8-1.0.0)
```

`in=`/`out=` 是输入与输出 token 数，末尾 `backend:` 是 DevEco 实际调度的模型。token 刷新、`401` 重试、登录等会话事件也会记录。

通过环境变量控制详细程度：`DEVECO_LOG_LEVEL=debug|info|warn|error`（默认 `info`）。

> opencode 自己的日志（`~/.local/share/opencode/log/`）只能看到请求打到 `http://127.0.0.1:17128/v2`，看不到 DevEco 侧细节。代理日志才是 DevEco 真实调用链路所在。

---

## Token 存储与刷新

| 凭证 | 位置 | 说明 |
|---|---|---|
| `accessToken`（30 分钟） | 代理内存中 | 下次请求自动刷新 |
| `jwtToken`（长效刷新凭证） | `~/.config/opencode/opencode-deveco/jwt.json` | 明文 JSON，`0600`；用 `XDG_CONFIG_HOME`/`OPENCODE_CONFIG_DIR` 覆盖目录 |

### token 过期 / 重启机器后需要重新登录吗？

**绝大多数情况都不需要** —— 只有当长效 `jwtToken` 本身失效（通常以天/周计）时才需要重新走浏览器登录。三种情况：

| 场景 | 需要重新登录？ | 实际发生的事 |
|---|---|---|
| `accessToken` 过期（每 30 分钟） | ❌ 不需要 | 代理用本地 jwtToken **静默刷新**，无浏览器、无操作。还有第二道保险：请求中被 DevEco 返回 `401` 时，代理会再刷新一次并重试。 |
| 重启机器 / 重启代理 | ❌ 不需要 | 代理启动时读取 `jwt.json` 并刷新恢复会话（`GET /v2/status` → `logged_in:true`），全程无头。你只需**重新启动代理进程**（`node dist/proxy.js`）；建议加入系统开机自启。 |
| jwtToken 也失效 | ⚠️ 才需要 | 当长效 jwtToken 在服务端不再有效时，刷新会失败。此时下次请求会自动触发浏览器登录，或手动执行 `curl http://127.0.0.1:17128/v2/login`。 |

代理启动时会尝试用已存的 jwtToken 恢复会话（启动即刷新）。失败则等下次请求触发浏览器登录。

---

## 限制

- **仅中国大陆站**。非 CN 的 `siteId` 会被拒绝。
- **代理必须常驻运行**，opencode 才能访问 DevEco（当前 opencode 不加载外部插件 auth）。建议做成后台服务 / 开机自启。
- **jwtToken 明文存储**（不加密）。如需加密，把 `JsonTokenStore` 换成加密实现即可，只改 `token-store.ts`。
- **同一账号只能跑一个代理实例**。共用同一份 `jwt.json` 的第二个进程刷新必定失败（DevEco 似乎会在一次刷新成功后使先前的刷新凭据失效），只能退回浏览器登录。
- **默认端口 17128**，opencode 侧无法直接配置；通过 `DEVECO_PROXY_PORT` 改并同步更新 provider 的 `baseURL`。

---

## 近期改进

Claude Code 长会话跑几轮就报错的问题，以及登录相关的修复，是近期的主要工作。每一项的来龙去脉见 `git log`。

- **上游超时改为「空闲超时」** — 只有当 DevEco **连续沉默** 120 秒才中断，取代原来那个会误杀长对话的 60 秒总时长上限。流被中断时补发真正的 Anthropic `error` 事件，不再直接截断。
- **强制指定工具可用了** — `tool_choice: {"type":"tool"}` 原本会让整个请求失败，DevEco 只接受枚举形式。
- **`max_tokens` 会被遵守** — Anthropic 路径上原本静默丢弃了这个字段。
- **Chat-Id 按对话保持稳定**，并在每轮结束时通过 `exitSessionQueue` 释放队列槽位。
- **登录不再阻塞** — `/v2/login` 立即返回重定向；未登录时发请求会快速失败并附上登录 URL，而不是一直挂着。
- **优雅关停**、**模型列表每小时刷新**、**HTTP 统一走 `fetch`**（自定义 `HttpClient` 已删除）、**lint 与测试**，以及所有端点的 `/v2` 前缀均可省略。

---

## 故障排查

- **`opencode run ... -m deveco/glm-5` 报连接被拒** → 代理没在跑。启动它（`node dist/proxy.js`）。
- **第一次请求弹了浏览器并返回 `401`** → 未登录时的正常表现：代理在后台发起登录，而不是让你干等。完成华为登录后重试即可；之后 30 分钟内都是无头的。
- **过一阵返回 `401`** → access token 过期且刷新失败（jwtToken 在服务端已失效）。再访问一次 `/v2/login`。
- **长回复中途报 `Upstream stream ended early`** → DevEco 在生成过程中沉默超过 120 秒。重试即可；若反复出现，多半是对话已超出模型上下文，需要压缩历史。
- **`opencode models` 没有 deveco 模型** → 检查 `opencode.json` 里有没有 `provider.deveco` 条目（这是配置驱动，不是插件驱动）。
- **非流式请求超时** → DevEco 的 `/no-stream` 接口可能较慢；请求体显式加 `"stream": true` 切回流式。代理默认以非流式转发 OpenAI 请求（仅显式 `stream: true` 才启用 SSE）；opencode 恒发 `stream: true`，不受影响。

---

## 项目结构

| 文件 | 作用 |
|---|---|
| [`src/proxy.ts`](./src/proxy.ts) | 本地代理服务（真正的 auth + 转发路径） |
| [`src/plugin.ts`](./src/plugin.ts) | opencode 插件（代理生命周期 + 前向兼容 auth hook） |
| [`src/anthropic-transform.ts`](./src/anthropic-transform.ts) | Anthropic Messages ↔ OpenAI Chat 协议转换 |
| [`src/auth-login.ts`](./src/auth-login.ts) | `LocalAuthServer` + `LoginService`（华为 OAuth 流程） |
| [`src/token-store.ts`](./src/token-store.ts) | jwtToken 的 JSON 持久化 |
| [`src/models.ts`](./src/models.ts) | 动态模型列表拉取 + 静态回退（1 小时缓存 TTL） |
| [`src/config.ts`](./src/config.ts) | 常量、默认值、端点 |

[`DevEco-OpenCode-Plugin-Plan.md`](./DevEco-OpenCode-Plugin-Plan.md) 是最初的设计文档（写在转代理方案之前）。

---

## 相关链接

- [opencode 官网](https://opencode.ai)
- [deveco-code（上游 fork）](https://github.com/anomalyco/opencode)
- [`@opencode-ai/plugin` 包](https://www.npmjs.com/package/@opencode-ai/plugin)

---

## 许可证

MIT
