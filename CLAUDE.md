# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
npm run build          # tsc 编译 src/ → dist/(含 .d.ts)
npm run typecheck      # 仅类型检查,不产出文件
npm run test           # vitest 运行全部测试
npx vitest run src/anthropic-transform.test.ts   # 运行单个测试文件
npx vitest run -t "关键字"                        # 按用例名过滤
npm run lint           # eslint 检查 src/
npm run clean          # 删除 dist/

# 运行代理(需先 build)
node dist/proxy.js                    # 前台运行,默认 127.0.0.1:17128
node dist/proxy.js --port=17129       # 或用 DEVECO_PROXY_PORT 环境变量
curl http://127.0.0.1:17128/v2/status # 查看登录态
```

## 架构

### 为什么是"本地代理"而不是纯插件

opencode 已发布的二进制**不会加载外部插件的 auth hooks**,无法通过插件系统注入 DevEco Bearer token。因此本项目的实际运行路径是一个本地 HTTP 代理(`src/proxy.ts`):opencode 把它当作普通 OpenAI 端点访问,代理持有凭证、注入 Authorization、应用 DevEco 的 URL 规则后转发到 `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2`。`src/plugin.ts` 的 auth hook 仅为前向兼容保留(未来 opencode 支持时直接注入 token、绕过代理)。

### 两个入口

- **独立 CLI**:`node dist/proxy.js`(`proxy.ts` 底部有 `isDirectRun` 守卫,被 import 时不会自动启动)
- **opencode 插件**:`index.ts` 导出 `{ id, server: DevEcoPlugin }`;`plugin.ts` 在加载时启动代理,并通过 config hook 注入指向本地代理的 `deveco` provider

### 请求流(核心路径,proxy.ts)

```
OpenAI 客户端     → POST /v2/chat/completions ─────────────────────┐
Claude Code      → POST /anthropic/v1/messages → anthropic-transform 转成 OpenAI ┘
  → ensureToken():内存 accessToken → jwtToken 静默刷新 → 后台拉起浏览器登录并立即 401(带登录 URL)
  → 注入 DevEco 必需 headers;非流式请求改写路径为 /no-stream/chat/completions
  → fetch 上游;若 401 则刷新 token 后重试一次
  → 流式:SSE 透传(Anthropic 路径经 openaiChatStreamToAnthropic 逆向转换);非流式:JSON
```

所有代理端点 `/v2` 前缀可选(路由入口统一 strip)。

### 凭证体系(三层)

| 凭证 | 生命周期 | 存放位置 | 代码 |
|---|---|---|---|
| jwtToken | 天/周级 | `~/.config/opencode/opencode-deveco/jwt.json`(0600 明文 JSON) | `token-store.ts` |
| accessToken | 30 分钟 | 代理进程内存(`Session`) | `proxy.ts` `ensureToken()` |
| 浏览器 OAuth | 一次性 | — | `auth-login.ts` |

登录流程(`auth-login.ts`):`LocalAuthServer` 在 127.0.0.1 候选端口(10101、34567–34570)监听 `/callback` → 打开浏览器到华为登录页(带 port + clientSecret,回调用 code 校验防伪)→ 回调携带 tempToken → 换 jwtToken → jwtToken 换 accessToken + userInfo。**仅支持中国站(siteId=1)**,其他站点抛 `UnsupportedRegionError`。

`startLogin()` 立即返回登录 URL + 一个后台 settle 的 promise,因此调用方**永远不阻塞在 10 分钟回调窗口上**:`GET /v2/login` 直接 302 跳转到该 URL,推理请求则后台开浏览器并立刻 401。代理用 `pendingLogin` 单飞去重,避免并发请求各起一个回调服务器泄漏端口。作为后台服务运行时若没有 `DISPLAY`,自动开浏览器会静默失败(仅 warn),此时靠返回的 URL 手动登录。

### 关键注意:DevEco 规则存在两份实现

`proxy.ts`(转发路径)和 `plugin.ts` 的 `buildAuthedFetch`(前向兼容 auth loader 路径)**各自实现了同一套 DevEco 规则**:非流式 `/no-stream` URL 改写、`Chat-Id` header、token 过期刷新。修改其中一处时,检查另一处是否需要同步。

### DevEco 上游怪癖(改转发逻辑前必读)

- 非流式请求必须用 `/no-stream/chat/completions` 路径(靠 URL 区分流式与否,不靠 body 的 `stream` 字段)
- 必需 headers:`Authorization: Bearer`、`Chat-Id`(32 位去连字符 UUID)、`lang`、`User-Agent`、`accept-language`
- 模型 id 是 `GLM-5.1`(不是 `glm-5`)
- 上游超时:聊天 60s,登录/token 接口 20s

### 其他模块

- `anthropic-transform.ts` — Anthropic Messages ↔ OpenAI Chat 双向协议转换(请求、非流式响应、SSE 流三种转换);支持 tool use、thinking/reasoning 块、图片。改编自 cc-haha(cc-switch)
- `models.ts` — 动态模型列表(GET `/codeGenie/modelConfig`,Bearer 认证)+ `config.ts` 中 `DEVECO_DEFAULTS` 静态兜底,缓存 1 小时;登录成功后调 `resetModelCache()`
- `config.ts` — 全部常量(端点、端口、token 生命周期)+ 极简 logger(info→stdout,warn/error→stderr,`DEVECO_LOG_LEVEL` 控制级别)

### 代码来源

核心登录/模型逻辑从 deveco-code fork(`packages/opencode/src/plugin/deveco*.ts`)移植而来,已剥离 fork 内部依赖;行为需与上游 DevEco Code 保持一致。

## 约定

- 纯 ESM(`"type": "module"` + NodeNext):源码内相对导入**必须带 `.js` 后缀**(如 `import { log } from "./config.js"`)
- TypeScript strict;ESLint 将 `any` 视为 error,未使用参数以 `_` 前缀豁免
- 测试与源码同目录(`src/*.test.ts`),vitest,无 mock 框架——现有测试只针对纯函数(`parseJwt`、协议转换、路径处理)
- 唯一运行时依赖是 `@opencode-ai/plugin`(仅用其类型);HTTP 一律用 Node 内置 `fetch`,不引入 HTTP 库
