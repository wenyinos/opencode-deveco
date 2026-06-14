# DevEco 接入普通 OpenCode 的独立插件方案

## 目标
- 将 `deveco-code` 里的账号登录能力拆出来，做成可独立安装、独立运行的 `opencode` 插件。
- 尽量不依赖 `deveco-code` 仓库本体，不复用 fork 内部模块。
- 让普通 `opencode` 通过插件即可获得 DevEco 登录、token 刷新、模型接入能力。

## 结论
- 可行，但需要做成“插件 + 用户配置”的组合，不是单纯改一个插件文件就能完整覆盖。
- 现有插件能力足够承载登录、凭据注入、provider/model 扩展。
- 现有插件能力不支持新增顶层 CLI 子命令，所以无法原生实现 `opencode deveco login`，只能复用 `opencode providers login` 或另做 wrapper。

## 现状拆解
- 登录链路在 `packages/opencode/src/plugin/deveco.ts`：本地回调端口、`tempToken`、JWT、`accessToken/refreshToken`。
- 请求注入在同一文件的 `auth.loader`：删除原 `Authorization`，注入 DevEco token，并重写非流式请求路径。
- 模型来源在 `packages/opencode/src/plugin/deveco-models.ts`：登录后拉取动态模型配置，失败回退默认模型。
- fork 特有 provider 注入在 `packages/opencode/src/provider/provider.ts`：普通 `opencode` 没有这段逻辑，插件需要自己补。

## 推荐架构
1. 新建独立插件包，例如 `opencode-deveco`
2. 插件只依赖 `@opencode-ai/plugin`、标准 `fetch`、`http`、`crypto`
3. `auth.methods` 负责登录
4. `auth.loader` 负责 token 注入和刷新
5. `config` hook 负责注入 `deveco` provider 默认配置
6. 登录后动态拉取模型列表，失败时回退默认模型

## 认证流程
- 用户执行 `opencode providers login`。
- 插件打开 DevEco 登录页，启动本地回调服务。
- 回调返回 `tempToken` 后换取 JWT，再换取 `accessToken/refreshToken`。
- 插件将凭据交给 `opencode` 现有 auth 存储。
- 请求阶段按需刷新 token，刷新失败则返回 401 并提示重新登录。

## Provider 接入
- Provider 基础配置：
  - `name`: `DevEco Code`
  - `npm`: `@ai-sdk/openai-compatible`
  - `api`: `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2`
- 模型列表通过 `codeGenie/modelConfig` 动态获取。
- 默认模型和黑名单策略保留回退值，避免接口失败时完全不可用。

## 依赖边界
- 不依赖 `deveco-code` 的数据库层、账号层、UI 层。
- 不依赖 fork 的 `LocalCrypto`、`Auth`、`Account`、`Config` 内部实现。
- 只保留协议层逻辑和必要的本地持久化。

## 风险
- 登录回调协议如果服务端改动，插件需要同步更新。
- 现有 `opencode` 版本若插件 API 行为变化，需要做兼容测试。
- 模型配置接口失败时只能回退静态默认模型，不能保证全部能力可用。

## 验证顺序
1. 先验证插件能被 `opencode plugin <module>` 安装
2. 再验证 `opencode providers login` 能完成 DevEco 登录
3. 再验证 token 能稳定刷新
4. 再验证 `deveco` provider 和模型能出现在 `opencode models`
5. 最后验证一次真实请求能正常打到 DevEco 接口

## 建议下一步
- 先做最小插件骨架，再补登录和注入逻辑。
- 如果你要，我可以继续把这个方案直接落成一个可安装的插件目录结构。
