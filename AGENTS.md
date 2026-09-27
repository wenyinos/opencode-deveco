# AGENTS.md

OpenCode 会话指引（本仓库唯一的 agent 指令文件）。详细用户文档见 `README.md` / `README_zh.md`。

## 常用命令

```bash
npm run build          # tsc 编译 src/ → dist/(含 .d.ts)
npm run typecheck      # 仅类型检查
npm run test           # vitest 运行全部测试
npx vitest run src/proxy.test.ts   # 运行单个测试文件
npx vitest run -t "关键字"          # 按用例名过滤
npm run lint           # eslint 检查 src/
npm run clean          # 删除 dist/

# 运行代理(需先 build)
node dist/proxy.js                    # 前台运行,默认 127.0.0.1:17128
npm start                             # daemon.js 监督 + 代理(退出自动重启)
curl http://127.0.0.1:17128/v2/status # 查看登录态
```

## 架构

### 为什么是"本地代理"而不是纯插件

opencode 已发布的二进制**不加载外部插件的 auth hooks**。实际运行路径是本地 HTTP 代理(`src/proxy.ts`):opencode 把它当普通 OpenAI 端点访问,代理注入 DevEco Bearer token 后转发到 `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2`。`src/plugin.ts` 的 auth hook 仅为前向兼容保留。

### 两个入口

- **独立 CLI**:`node dist/proxy.js`(`proxy.ts` 底部 `isDirectRun` 守卫,被 import 时不会自动启动)
- **opencode 插件**:`index.ts` 导出 `{ id, server: DevEcoPlugin }`;`plugin.ts` 加载时启动代理,并通过 config hook 注入 `deveco` provider

### 请求流(核心路径,proxy.ts)

- OpenAI 客户端 → `POST /v2/chat/completions`
- Claude Code → `POST /anthropic/v1/messages` → `anthropic-transform.ts` 双向转换(请求/非流式响应/SSE 流,支持 tool use、thinking、图片)
- → `ensureToken()`:内存 accessToken → jwtToken 静默刷新 → 未登录则后台拉起浏览器并立即 401(带登录 URL)
- → 注入 DevEco 必需 headers;非流式改写路径为 `/no-stream/chat/completions`
- → 401 时刷新 token 重试一次
- 所有端点 `/v2` 前缀可选(路由入口统一 strip)

### 凭证体系(三层)

| 凭证 | 生命周期 | 存放位置 | 代码 |
|---|---|---|---|
| jwtToken | 天/周级 | `~/.config/opencode/opencode-deveco/jwt.json`(0600 明文 JSON) | `token-store.ts` |
| accessToken | 30 分钟 | 代理进程内存 | `proxy.ts` `ensureToken()` |
| 浏览器 OAuth | 一次性 | 回调端口候选 10101、34567–34570,仅绑 loopback | `auth-login.ts` |

仅支持中国站(siteId=1)。`startLogin()` 立即返回 URL 不阻塞;`pendingLogin` 单飞去重。无 `DISPLAY` 时自动开浏览器静默失败,靠返回的 URL 手动登录。

### 关键注意:DevEco 规则存在两份实现

`proxy.ts`(转发路径)和 `plugin.ts` 的 `buildAuthedFetch`(前向兼容路径)**各自实现了同一套规则**:非流式 URL 改写、`Chat-Id` header、token 刷新。改一处时检查另一处是否需同步。

## DevEco 上游怪癖(改转发逻辑前必读)

- 非流式必须用 `/no-stream/chat/completions` 路径(靠 URL 区分流式与否,不靠 body 的 `stream` 字段)
- 必需 headers:`Authorization: Bearer`、`Chat-Id`(32 位去连字符 UUID)、`lang`、`User-Agent`、`accept-language`
- 模型 id 是 `GLM-5.1` / `GLM-5.3`(不是 `glm-5`);`deepseek-v4-flash` 是隐藏模型,不在动态模型列表中,须手工指定
- **`tool_choice` 是枚举**,只收 `"auto"|"none"|"required"`。发 OpenAI 对象形式会让整个请求 400;指定某工具靠 `"required"` + 收窄 `tools` 模拟
- **服务端按 (`Session-Id`, `Chat-Id`) 维护轮次状态**,每轮结束 POST `exitSessionQueue` 释放槽位(等待上限 3s);Chat-Id 以对话**首条 user 消息**为键(不是 `messages[0]`——那是 system prompt,易变会话会疯狂新开上游 session),`DEVECO_SESSION_KEY_MODE=system-first` 恢复旧行为;客户端可用 `x-session-id` 等头显式固定
- 聊天用**空闲超时**(沉默 120s 才断,`UPSTREAM_IDLE_TIMEOUT_MS`),不能用总时长超时——`AbortSignal.timeout` 会掐断已在流的请求,长对话必然误伤;登录/token 接口是普通 20s 超时
- 同一 jwtToken 不支持两个进程并发刷新,只能跑单实例
- 文本模型(GLM-5.1/5.3,`input_modalities: ["text"]`)收到含图请求会 403,代理自动改路由到视觉模型 `Qwen3_VL_235B_A22B_Instruct`(`vision-routing.ts`;`DEVECO_VISION_MODEL` / `DEVECO_TEXT_ONLY_MODELS` 可覆盖)
- 并发控制:同时仅 1 个上游生成(`DEVECO_MAX_CONCURRENCY`),超出排队(上限 `DEVECO_MAX_QUEUE=3`,再超出直接 429),排队请求入场前冷却 `DEVECO_QUEUE_COOLDOWN_SEC`(默认 1s)。`/v2/status` 等元数据端点不排队

## 其他模块

- `daemon.ts` — 监督进程,代理退出后按退避重启(1s→2s→…上限 30s)
- `openai-normalize.ts` — OpenAI 请求规范化
- `models.ts` — 动态模型列表(GET `/codeGenie/modelConfig`)+ `config.ts` 中 `DEVECO_DEFAULTS` 静态兜底,缓存 1 小时;登录成功后 `resetModelCache()`
- `config.ts` — 全部常量(端点、端口、token 生命周期、并发/队列默认值)+ 极简 logger(`DEVECO_LOG_LEVEL` 控制级别,info→stdout,warn/error→stderr)
- `scripts/` — Windows/Linux/macOS 自启动脚本(npm 包会随 `files` 一并发布)

## 代码来源

核心登录/模型逻辑从 deveco-code fork(`packages/opencode/src/plugin/deveco*.ts`)移植,已剥离 fork 内部依赖;行为需与上游 DevEco Code 保持一致。

## 约定

- 纯 ESM(`"type": "module"` + NodeNext):源码内相对导入**必须带 `.js` 后缀**(如 `import { log } from "./config.js"`)
- TypeScript strict;ESLint 将 `any` 视为 error,未使用参数以 `_` 前缀豁免
- 测试与源码同目录(`src/*.test.ts`),vitest,无 mock 框架——现有测试只针对纯函数(协议转换、路径处理、Chat-Id 派生等);proxy 测试用 stub 全局 `fetch`,不依赖真实上游
- 唯一运行时依赖是 `@opencode-ai/plugin`(仅用其类型);HTTP 一律用 Node 内置 `fetch`,不引入 HTTP 库
