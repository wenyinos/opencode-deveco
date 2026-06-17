# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

opencode-deveco 是一个 [opencode](https://opencode.ai) 插件，让标准 opencode 能使用华为 DevEco Code 的 GLM 模型（中国站账号）。

**核心架构**：由于 opencode 不加载外部插件的 auth hook，本项目采用**本地代理**方案——opencode 将代理视为普通 OpenAI 端点，代理负责注入 Bearer token 并转发请求到 DevEco 后端。

```
opencode → http://127.0.0.1:17128/v2 (本地代理)
               ↓ 注入 Authorization + /no-stream URL 路径转换
          https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2
```

插件入口 `src/plugin.ts` 同时保留了 auth hook 的前向兼容路径，未来 opencode 支持外部插件 auth 时可绕过代理。

## 常用命令

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript → dist/
npm run typecheck    # 类型检查（不生成产物）
npm run test         # 运行测试（vitest）
npm run lint         # ESLint 检查
npm run clean        # 删除 dist/
node dist/proxy.js   # 单独启动代理（前台，调试用）
```

## 源文件职责

| 文件 | 职责 |
|---|---|
| `src/proxy.ts` | 本地 HTTP 代理服务器（核心转发路径） |
| `src/plugin.ts` | opencode 插件入口（config hook + auth hook + 代理生命周期） |
| `src/auth-login.ts` | Huawei OAuth 浏览器登录流程（LocalAuthServer + LoginService） |
| `src/token-store.ts` | jwtToken JSON 持久化存储（`~/.config/opencode/opencode-deveco/jwt.json`） |
| `src/models.ts` | 动态模型列表拉取 + 静态回退（1 小时缓存 TTL） |
| `src/config.ts` | 常量、端点、默认配置、ProviderInfo/ModelInfo 类型、日志工具 |

## 关键设计细节

- **Token 生命周期**：accessToken 30 分钟过期，代理自动用 jwtToken（长期凭证）无感刷新；若 jwtToken 也过期则触发浏览器登录
- **DevEco URL 规则**：流式请求走 `/v2/chat/completions`，非流式走 `/v2/no-stream/chat/completions`（代理自动转换路径）
- **代理默认端口**：17128，可通过 `DEVECO_PROXY_PORT` 环境变量覆盖
- **日志级别**：`DEVECO_LOG_LEVEL=debug|info|warn|error`（默认 info），输出到 stdout/stderr
- **仅中国站**：非中国站 siteId 会被拒绝
- **请求超时**：上游 DevEco 请求 60 秒超时（`AbortSignal.timeout`），login/token 端点 20 秒超时
- **优雅关停**：监听 SIGTERM/SIGINT，`stop()` 等待活跃请求完成后再关闭
- **模型缓存 TTL**：`models.ts` 的动态模型列表缓存 1 小时后自动刷新
- **路由**：所有端点统一 strip `/v2` 前缀，`/v2/status` 和 `/status` 均有效

## opencode 插件协议

插件通过 `@opencode-ai/plugin` 包导出 `Plugin` 类型，返回 `Hooks` 对象：
- `config` hook：注入 `deveco` provider 到 opencode 配置
- `auth.loader`：前向兼容，返回自定义 fetch 函数注入 Bearer token
- `auth.methods[0]`：定义 Huawei OAuth 登录流程
