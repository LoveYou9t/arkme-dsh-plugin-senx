# Arkme Service 业务域解耦设计

## 背景

当前 `src/arkme-service.ts` 共 9893 行。`ArkmeService` 同时承担基础 HTTP、Session 与 Token 刷新、请求协调、业务响应投影、缓存、opaque refs、Realtime、生命周期以及大量业务流程。Host API、Tools、SDK Provider、Realtime 和测试都直接依赖它，因此不能通过改名或批量移动方法破坏现有调用面。

本次只做结构重构，不新增业务能力，不修改 DSH 源码或公开机制。

## 目标

- 新增顶层 `src/services/` 目录。
- `src/services/service.ts` 只承载跨业务基础运行时。
- 每个产品业务域拥有独立 Service 文件、状态和响应转换。
- `src/arkme-service.ts` 保留为兼容 façade，最终只负责构造、组合、公开方法委托和统一释放。
- 保持现有 Host、Tools、SDK、UI、存储和远端接口行为兼容。
- 通过渐进迁移和聚焦测试，避免一次性移动全部代码后集中排错。

## 非目标

- 不改变 `ArkmeService` 的构造参数、公开方法名、参数、返回类型或错误语义。
- 不改变 `ArkmePluginError` 的导出位置、错误码、HTTP 状态或可重试语义。
- 不改变 `ctx.arkmeData`、Provider contract、Host API operation、Tool 名称与 Schema。
- 不改变远端 URL、请求路径、请求体、SQLite、SessionStore、Keychain、缓存 TTL 或 opaque ref 语义。
- 不重构 DSH，不导入 DSH 私有源码，不增加新的产品功能。

## 兼容合同

以下入口保持不变：

```ts
import {
  ArkmePluginError,
  ArkmeService,
  type ArkmeServiceConfig,
} from './arkme-service.js'
```

`new ArkmeService(config, sessionStore, stateStore, fetchImpl, pendingSessionStore, outgoingCallBroker)` 的参数顺序和默认值保持不变。`Context.arkmeData` 仍为 `ArkmeService`，调用方不需要知道内部业务 Service。

## 总体架构

```text
Host API / Tools / SDK / UI / Realtime
                  |
                  v
        ArkmeService compatibility facade
                  |
       +----------+----------+
       |          |          |
       v          v          v
 AuthService  ChatService  RecordService ...
       |          |          |
       +----------+----------+
                  |
                  v
       services/service.ts runtime
                  |
                  v
        upstream APIs and local stores
```

`ArkmeService` 对外保持一个对象，对内使用组合，不使用 prototype 拼装或 mixin。业务 Service 不反向导入 façade。

## 目录结构

```text
src/services/
├── service.ts
├── auth-service.ts
├── profile-service.ts
├── bot-service.ts
├── source-service.ts
├── chat-service.ts
├── chat-realtime-service.ts
├── group-service.ts
├── group-ai-polish-service.ts
├── record-service.ts
├── related-recording-service.ts
├── recording-service.ts
├── search-service.ts
├── media-service.ts
├── world-service.ts
├── arrangement-service.ts
├── wechat-service.ts
├── arko-service.ts
├── ai-video-service.ts
├── outgoing-call-service.ts
├── interwoven-service.ts
├── community-service.ts
└── extension-review-service.ts
```

文件按产品业务域划分，而不是按 `authBaseUrl`、`chatBaseUrl` 等上游地址划分。一个完整产品流程即使调用多个上游服务，也由同一个业务 Service 拥有。

## 基础运行时

`src/services/service.ts` 提供共享运行时和稳定基础类型：

- `ArkmeServiceConfig`、`StateStore`、`FetchLike` 等构造依赖。
- `RequestCoordinator`、请求 scope、lane、cache 与 cooldown。
- Session 读取、Token refresh、鉴权失效处理。
- `get/post`、超时、AbortSignal、Envelope 解析与网络错误转换。
- 统一基础 `dispose()`。

基础运行时不包含：

- 具体业务 API path 或业务请求体。
- 业务响应投影。
- 业务缓存、pending state 或 opaque refs。
- Host、Tool、SDK 或 UI 方法。

这样可以防止 `services/service.ts` 变成新的巨型基类。业务 Service 通过构造器组合共享运行时，而不是继承后持续扩大 protected API。

## 业务 Service 规则

每个业务 Service：

- 只拥有一个清晰产品业务域。
- 自己持有所属缓存、in-flight、timer、opaque refs 和 pending state。
- 负责自己的远端 path、请求体、响应验证和业务错误。
- 不依赖 `ArkmeService` façade。
- 不直接依赖另一个具体业务 Service。
- 确需跨域读取时，通过窄 Port 注入，例如 `ProfileReader`、`SourceResolver`、`MediaReader`。
- 有生命周期资源时实现 `dispose()`；无资源时不制造空生命周期接口。

共享 Port 只描述消费方实际需要的方法，不能直接暴露整个业务 Service。

## 状态所有权

- 登录尝试、pending binding 和登录流程归 `AuthService`。
- Profile 与 public profile 缓存归 `ProfileService`。
- Chat source、timeline、发送和已读归 `ChatService`。
- SSE、projection sequence、retry timer 和 client listener 归 `ChatRealtimeService`。
- 图片缓存、下载并发和 media refs 归 `MediaService`。
- World、Arrangement、Extension Review 等引用表归各自业务 Service。
- Outgoing call broker 和 lease 归 `OutgoingCallService`。
- RequestCoordinator 与跨域请求级 cooldown 归基础运行时。

业务状态不得为方便委托继续堆在 façade 中。

## 调用与错误流

```text
consumer call
  -> ArkmeService public method
  -> domain service method
  -> shared runtime request
  -> upstream response
  -> domain validation and projection
  -> unchanged public result
```

基础运行时处理网络、超时、鉴权失效和通用 Envelope。业务 Service 处理业务 code、业务响应结构和投影。已有 `ArkmePluginError` 必须原样透传，不使用 catch/rethrow 改写 code、状态或 retryability。

## 生命周期

`ArkmeService.dispose()` 负责统一释放，顺序为：

1. 停止会产生新任务的业务 Service 与 Realtime。
2. 清理业务 timer、listener、in-flight bookkeeping 和引用缓存。
3. 释放 OutgoingCallBroker 等业务资源。
4. 最后释放 RequestCoordinator 和基础运行时。

`startChatRealtime()` 返回的 stop 函数仍保持现有行为。重复 dispose 不得泄漏资源或产生新的异步任务。

## 消费面兼容

本次不新增业务能力，但必须验证现有三个消费面：

| 能力面 | 兼容要求 | 验证 |
| --- | --- | --- |
| Tools | 名称、Schema、grant、结果与错误不变 | 结构测试、聚焦工具测试、正式 DSH Tool 注册 smoke |
| SDK | `ctx.arkmeData`、公开导出、Provider contract 不变 | 类型检查、SDK 合同测试、Provider 注入 smoke |
| UI | Host API operation、参数和响应不变 | Host API 测试、代表性 UI 请求 smoke |
| Host owner | 同一业务方法只有一个实现 owner | façade 委托测试、禁止重复业务逻辑的结构门禁 |

## 渐进迁移

### 阶段一：冻结兼容合同

- 增加构造器、公开导出、公开方法和调用面结构测试。
- 建立禁止业务 Service 导入 façade 的依赖门禁。
- 记录当前聚焦测试与全量门禁基线。

### 阶段二：提取基础运行时

- 将请求协调、Session、Token refresh、HTTP 和通用错误转换迁入 `services/service.ts`。
- 业务方法暂时保留在 façade，通过基础运行时完成原调用。
- 证明基础抽取没有改变网络和错误行为。

### 阶段三：迁移低耦合业务

依次迁移 Bot、AI Video、Arrangement、Recording、WeChat、Extension Review。每迁移一个域：

- 先补或确认该域行为测试。
- 将该域状态、helpers 和公开方法迁入业务 Service。
- 将 façade 方法改为纯委托。
- 运行该域聚焦测试、类型检查和 diff 检查。

### 阶段四：迁移高共享业务

迁移 Profile、Media、Source、Chat、Realtime、Auth、Interwoven、Group AI Polish 等高共享域。跨域依赖先抽为窄 Port，再移动业务实现，禁止用 façade 作为临时 service locator。

### 阶段五：收口 façade

- 删除 façade 中已无 owner 的缓存、helper 和业务 imports。
- 保留构造组装、公开委托、兼容导出和统一 dispose。
- 增加结构门禁：façade 不包含远端 path、业务响应字段读取或业务缓存声明。

各阶段在同一隔离 worktree 中形成原子提交，全部兼容门禁通过后再形成完整 MR，避免主分支长期处于半迁移状态。

## 测试策略

- 迁移前使用现有测试作为 characterization tests；缺少关键失败路径时先补测试。
- 每个业务 Service 增加独立构造和行为测试，避免只能通过 façade 测试。
- façade 测试只验证组装、委托、兼容类型和生命周期，不重复业务用例。
- 增加依赖方向测试：`services/*-service.ts` 不得导入 `arkme-service`。
- 增加 façade 结构测试：不得包含具体 `/api/` path、业务字段投影或业务缓存常量。
- 每个阶段运行聚焦测试、`pnpm run typecheck`、`pnpm test`、`pnpm run build`。
- 最终运行 `pnpm run verify:call-assets`，确保现有资源门禁无回归。

## 打包与运行验收

- 生成不可变 `.tgz` 并检查包清单。
- 使用未修改的官方 DSH、全新临时 `DSH_HOME`、Profile 和空闲端口安装 `.tgz`。
- 验证插件加载、Host API、Tool 注册、SDK Provider 注入和 Realtime 生命周期 smoke。
- 本次不触碰任何常驻 DSH、真实 Profile 或 DSH 源码 checkout。

## 风险与控制

- 风险：跨域 private helper 被错误地放入基础运行时。控制：只有两个以上业务域真实消费的基础能力才能进入 `service.ts`。
- 风险：为了快速迁移让业务 Service 依赖 façade。控制：从阶段一开始启用反向依赖门禁。
- 风险：方法委托时改变默认参数、this 绑定或错误透传。控制：使用显式 façade 方法，不直接暴露未绑定函数引用。
- 风险：状态移动后 dispose 顺序变化。控制：生命周期测试覆盖 timer、listener、broker 和 RequestCoordinator。
- 风险：单个新业务 Service 再次过大。控制：按完整产品流程聚合；出现两个独立 owner 时继续拆分，而不是按行数机械拆 helper。

## 完成标准

- `src/arkme-service.ts` 只承担兼容 façade 职责。
- 所有已识别业务域均迁入独立 Service。
- 基础运行时不包含业务 path、投影、缓存或消费面方法。
- Host、Tools、SDK、UI 的公开合同无变化。
- 全量代码门禁、打包和未修改官方 DSH 的临时环境验收通过。
- Arkme 插件仓以外没有源码改动。
