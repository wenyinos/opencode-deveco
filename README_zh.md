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

**Linux / macOS —— systemd 用户服务（自启 + 自动重启）：**

```bash
mkdir -p ~/.config/systemd/user
cp scripts/opencode-deveco.service ~/.config/systemd/user/
# 编辑复制后的文件里的 ExecStart / WorkingDirectory 为你的实际安装路径
systemctl --user daemon-reload
systemctl --user enable --now opencode-deveco
journalctl --user -u opencode-deveco -f   # 实时看日志
```

> 这个 systemd unit 在用户登录时自启。要实现开机自启（登录前就启动）运行 `loginctl enable-linger $USER`。

### 4. 登录

访问代理的登录端点即可 —— 会打开浏览器走华为 OAuth 并等待回调：

```bash
curl http://127.0.0.1:17128/v2/login
# → {"ok":true,"user":"...","expires_in_ms":1800000}
```

如果尚未登录，第一次发请求时代理也会自动触发登录。

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
| `POST /v2/chat/completions` | OpenAI 兼容 — 转发到 DevEco |
| `POST /anthropic` | Anthropic Messages API — 自动转换为 OpenAI 格式 |
| `GET  /v2/models` | DevEco 模型列表（动态获取，失败回退静态；1 小时缓存 TTL） |
| `GET  /v2/login` | 强制触发浏览器华为 OAuth 登录 |
| `GET  /v2/status` | `{ logged_in, user, expires_in_ms }` |
| `GET  /v2/logout` | 清除已存凭证 |

> 所有端点均可省略 `/v2` 前缀（如 `GET /status`）。

---

## Claude Code 集成

代理同时支持 **Anthropic Messages API**（`POST /anthropic`），自动将请求转换为 OpenAI Chat Completions 格式。这让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 可以直接使用 DevEco 模型。

启动 Claude Code 前设置以下环境变量：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:17128/anthropic
export ANTHROPIC_API_KEY=opencode-oauth-dummy-key
export ANTHROPIC_MODEL=GLM-5.1
```

然后正常启动 Claude Code 即可 —— 它会将 Anthropic Messages API 请求发送到代理，代理自动转换为 OpenAI 格式转发给 DevEco，再将响应转换回 Anthropic 格式。

支持：流式传输、工具调用（function calling）、thinking/reasoning 块、图片内容。

---

## 日志与可观测性

代理把每次请求打到 **stdout**（info）和 **stderr**（warn/error）。怎么看日志取决于启动方式 —— **Windows/Linux/mac 完全一致**：

| 运行方式 | 命令 | 日志位置 |
|---|---|---|
| **前台运行（调试首选）** | `node dist/proxy.js` | 实时打印在当前终端 |
| 后台 → 文件 | 见上方"启动代理"（重定向 `> proxy.log 2>&1`） | 写到 `proxy.log`；用 `tail -f proxy.log`（Linux/mac）或 `Get-Content -Wait proxy.log`（PowerShell）查看 |

每个请求产生两行日志 —— 请求行和响应行：

```
[2026-06-14T16:53:24.999Z] [INFO] -> POST stream model=GLM-5.1
[2026-06-14T16:53:27.150Z] [INFO] <- 200 2151ms in=2677 out=7 model=GLM-5.1 (backend: GLM5_1_W4A8-1.0.0)
```

字段含义：方向（`->` 请求 / `<-` 响应）、HTTP 状态码、耗时、token 用量（`in=` 输入、`out=` 输出）、请求的模型名、DevEco 后端实际服务的模型。会话生命周期事件也会记录（`restored DevEco session`、`refreshed DevEco access token`、`upstream 401 → refreshed token`、`no valid DevEco token; starting browser login`）。

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
- **默认端口 17128**，opencode 侧无法直接配置；通过 `DEVECO_PROXY_PORT` 改并同步更新 provider 的 `baseURL`。

---

## 近期改进

- **优雅关停** — 代理收到 SIGTERM/SIGINT 后会等待正在处理的请求完成再退出，systemd 服务停止时不再丢失请求。
- **请求超时** — 转发到 DevEco 的请求 60 秒超时；login/token 端点 20 秒超时，避免后端卡死导致代理无限挂起。
- **模型列表缓存 TTL** — 动态模型列表每小时自动刷新（此前永不过期，需重启才能获取新模型）。
- **统一 HTTP 栈** — 删除自定义 `HttpClient`，所有 HTTP 调用统一使用 Node 内置 `fetch`。
- **ESLint + 测试** — 新增 `npm run lint` 和 `npm run test`。
- **`/v2` 前缀可选** — 所有代理端点均可省略 `/v2` 前缀。

---

## 故障排查

- **`opencode run ... -m deveco/glm-5` 报连接被拒** → 代理没在跑。启动它（`node dist/proxy.js`）。
- **第一次请求弹了浏览器** → 正常，完成华为登录即可；30 分钟内的后续请求都是无头的。
- **过一阵返回 `401`** → access token 过期且刷新失败（jwtToken 在服务端已失效）。再访问一次 `/v2/login`。
- **`opencode models` 没有 deveco 模型** → 检查 `opencode.json` 里有没有 `provider.deveco` 条目（这是配置驱动，不是插件驱动）。
- **非流式请求超时** → DevEco 的 `/no-stream` 接口可能较慢；优先用流式（opencode 默认就是）。

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
