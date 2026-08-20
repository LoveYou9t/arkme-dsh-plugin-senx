# Arkme Service 业务域解耦实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 9893 行的 `src/arkme-service.ts` 重构为兼容 `ArkmeService` façade、共享基础运行时和按产品业务域划分的独立 Service，同时保持 Host、Tools、SDK、UI、远端接口和本地存储行为不变。

**Architecture:** `src/arkme-service.ts` 保留现有构造器、公开方法和导出，内部组合 `src/services/*-service.ts`。`src/services/service.ts` 只拥有 Config、Store、Session、RequestCoordinator、HTTP、Token refresh 和通用错误转换；业务 path、投影、缓存、refs 和 pending state 由对应业务 Service 拥有。

**Tech Stack:** TypeScript 6、Node.js 22+、Vitest 4、pnpm 11、Cordis、官方 DSH CLI。

**Design:** `docs/superpowers/specs/2026-08-20-arkme-service-decomposition-design.md`

---

## 全局约束

- 唯一业务代码可写根是当前 Arkme 插件 worktree。
- DSH 源码只读；不创建 DSH 分支、不提交 DSH 改动。
- 不改变 `ArkmeService` 构造参数、公开方法、返回类型、错误码或默认参数。
- 不改变 `ArkmePluginError`、`ArkmeServiceConfig` 和 `ctx.arkmeData` 的兼容导入。
- 不改变 Host API operation、Tool 名称/Schema/grant、SDK Provider contract、远端 path/body、SQLite、Keychain、SessionStore、TTL 或 opaque ref 语义。
- 业务 Service 不得导入 `../arkme-service.js`，也不得接收整个 façade 作为依赖。
- 跨业务调用只通过窄 Port；Port 由 owner 文件导出，消费方依赖接口而非具体 Service。
- 每个 façade 方法使用显式 prototype 方法委托；不用箭头字段、prototype patch、mixin 或未绑定函数引用。
- 每完成一个任务，先运行列出的聚焦测试，再提交；不得把多个未验证业务域堆到同一提交。

## 目标文件结构

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

---

### Task 0: 刷新实施基线并记录现有门禁

**Files:**
- Verify: `package.json`
- Verify: `src/arkme-service.ts`
- Verify: `tests/arkme-service.test.ts`

- [ ] **Step 1: 确认当前 worktree 只包含已批准文档提交**

Run:

```bash
git status --short --branch
git log --oneline origin/master..HEAD
```

Expected: 工作区干净；`origin/master..HEAD` 只包含设计/计划文档提交。

- [ ] **Step 2: 刷新最新 GitHub master**

Run:

```bash
git fetch origin master --prune
git rev-list --left-right --count origin/master...HEAD
```

Expected: 若输出第一列非零，且工作区仍只有本任务文档提交，则运行 `git rebase origin/master`；完成后 behind 为 `0`。冲突只在当前 worktree 解决。

- [ ] **Step 3: 安装锁定依赖**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: 依赖安装成功，`pnpm-lock.yaml` 无变化。

- [ ] **Step 4: 运行完整基线**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:call-assets
```

Expected: 全部退出 0；记录测试通过/跳过数量。若失败，先在同一最新基线复现并归类，不开始重构。

---

### Task 1: 固化 ArkmeService 公开兼容合同和依赖方向

**Files:**
- Create: `tests/service-architecture.test.ts`
- Modify: `tests/arkme-identity.test.ts`
- Verify: `src/arkme-service.ts`

- [ ] **Step 1: 写公开方法合同测试**

Create `tests/service-architecture.test.ts` with this AST-based contract:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

const expectedPublicMethods = [
  'startChatRealtime', 'chatRealtimeState', 'subscribeChatRealtime', 'chatRealtimeInitialEvent',
  'attachOpenClawProvisioner', 'connectOpenClawBot', 'listBots', 'createBot', 'revealBotSecret',
  'openBotChat', 'listGroupBots', 'addGroupBot', 'removeGroupBot', 'authStatus', 'clientConfig',
  'providerCapabilities', 'providerState', 'requestOutgoingCall', 'claimOutgoingCallIntent',
  'resolveOutgoingCallIntent', 'prepareOutgoingCall', 'heartbeatOutgoingCall', 'releaseOutgoingCall',
  'dispose', 'requestStats', 'cachedProfile', 'extensionAuthors', 'listExtensionReviews',
  'createExtensionReview', 'recordingCalendar', 'recordingTranscript', 'recordingProjection',
  'sealRecordingCursor', 'openRecordingCursor', 'recordingDay', 'refreshProfile', 'arkoProfile',
  'arkoEnsureSession', 'arkoCreateSession', 'arkoModelCatalog', 'arkoActivateModel', 'arkoHistoryPage',
  'arkoAsk', 'arkoRunStatus', 'arkoCancel', 'aiVideoPreflight', 'aiVideoCreate', 'aiVideoStatus',
  'aiVideoList', 'queryFileAssets', 'textAiVideoPreflight', 'textAiVideoCreate',
  'checkArkmeIdAvailability', 'setArkmeIdOnce', 'createTopic', 'listSources',
  'dshBetaCommunityEntryState', 'interwovenMoments', 'interwovenMomentDetail',
  'joinDSHBetaCommunity', 'inspectGroupAiPolish', 'inspectGroupAiPolishByName',
  'readGroupAiPolishNotices', 'generateGroupAiPolishRuleForSource', 'generateGroupAiPolishRule',
  'confirmEnableGroupAiPolish', 'prepareDisableGroupAiPolishForSource', 'prepareDisableGroupAiPolish',
  'confirmDisableGroupAiPolish', 'listGroupMembers', 'groupSettings', 'setGroupMessageDnd',
  'renameGroup', 'leaveGroup', 'dissolveGroup', 'reportGroup', 'userCard',
  'openPrivateChatFromUser', 'readSource', 'relatedRecordingEligibility', 'relatedRecordings',
  'recordRelatedRecordingsToolEvent', 'reportMessage', 'sendSourceText', 'retryGroupAiPolish',
  'sendSourceRich', 'longArticleDetail', 'updateLongArticle', 'getLongArticleDraft',
  'putLongArticleDraft', 'removeLongArticleDraft', 'uploadLocalFile', 'fetchMedia', 'sendDirectText',
  'markSourceRead', 'listWechatConversations', 'readWechatMessages', 'getWechatConversationDetail',
  'listWechatGroupMembers', 'listWechatPhones', 'listWechatCommonGroups', 'listWechatMoneyFlows',
  'listWechatLocations', 'readImage', 'beginWechatLogin', 'pollWechatLogin', 'testLogin',
  'sendPhoneCode', 'verifyPhoneCode', 'logout', 'cachedSnapshot', 'queryCached', 'refreshLatest',
  'refreshSnapshot', 'searchRecords', 'searchRemote', 'searchHistory', 'createSearchHistory',
  'searchScene', 'searchRecordings', 'syncHistory', 'summary', 'list', 'listWorldRecords',
  'listArrangements', 'arrangementDetail', 'listArrangementReminders', 'arrangementReminderSummary',
  'mutateArrangement', 'setArrangementReminderEnabled', 'markArrangementRemindersRead',
  'markAllArrangementRemindersRead', 'clearArrangementReminders', 'listWorldFeed',
  'listWorldInteractions', 'createWorldTextInteraction', 'readWorldImage',
  'publishWorldTextForConversation', 'createText', 'createTextForConversation', 'pendingWrites',
  'retryPending', 'extensionPost',
].sort()

function publicMethodNames(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const service = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArkmeService')
  if (service === undefined || !ts.isClassDeclaration(service)) throw new Error('ArkmeService class not found')
  return service.members
    .filter((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member))
    .filter(member => !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword))
    .map(member => member.name.getText(file))
    .sort()
}

describe('Arkme service architecture', () => {
  it('preserves the public facade method contract', () => {
    expect(publicMethodNames(join(root, 'src/arkme-service.ts'))).toEqual(expectedPublicMethods)
  })

  it('has a services runtime root', () => {
    expect(existsSync(join(root, 'src/services/service.ts'))).toBe(true)
  })

  it('prevents domain services from importing the facade', () => {
    const directory = join(root, 'src/services')
    if (!existsSync(directory)) return
    for (const file of readdirSync(directory).filter(name => name.endsWith('-service.ts'))) {
      expect(readFileSync(join(directory, file), 'utf8')).not.toMatch(/from ['"]\.\.\/arkme-service/)
    }
  })
})
```

- [ ] **Step 2: 运行测试，确认 services runtime 用例失败**

Run:

```bash
pnpm vitest run tests/service-architecture.test.ts
```

Expected: public method合同通过；`has a services runtime root` 因 `src/services/service.ts` 不存在而失败。

- [ ] **Step 3: 在 identity 测试中登记新结构文件**

Extend `tests/arkme-identity.test.ts` so its source inventory treats `src/services/**/*.ts` as first-party Arkme code and does not assume every service implementation remains in `src/arkme-service.ts`.

- [ ] **Step 4: 提交兼容合同**

Run:

```bash
git add tests/service-architecture.test.ts tests/arkme-identity.test.ts
git commit -m "test(architecture): 功能点: 固化 ArkmeService 兼容合同"
```

---

### Task 2: 提取共享 ServiceRuntime

**Files:**
- Create: `src/services/service.ts`
- Create: `tests/service-runtime.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-service.test.ts`
- Test: `tests/request-coordinator.test.ts`

- [ ] **Step 1: 写基础错误和请求行为失败测试**

Create `tests/service-runtime.test.ts` covering exact existing semantics:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ArkmePluginError, ServiceRuntime } from '../src/services/service.js'

describe('ServiceRuntime', () => {
  it('preserves upstream status and retry-after on HTTP failures', async () => {
    const runtime = runtimeFixture(async () => new Response('', {
      status: 429,
      headers: { 'retry-after': '2' },
    }))

    await expect(runtime.postDirect('https://example.test', '/api/test', {}, undefined, [200]))
      .rejects.toMatchObject({
        code: 'arkme-http-error',
        upstreamStatus: 429,
        retryAfterMillis: 2_000,
      })
  })

  it('passes existing ArkmePluginError through unchanged', async () => {
    const original = new ArkmePluginError('domain-failure', '业务失败', false, 409)
    const runtime = runtimeFixture(vi.fn().mockRejectedValue(original))
    await expect(runtime.getDirect('https://example.test', '/api/test', undefined, [200]))
      .rejects.toBe(original)
  })
})
```

Implement `runtimeFixture` in the same file with in-memory SessionStore/StateStore doubles matching existing `tests/arkme-service.test.ts` fixtures. Do not import the façade.

- [ ] **Step 2: 运行测试，确认模块缺失**

Run:

```bash
pnpm vitest run tests/service-runtime.test.ts tests/service-architecture.test.ts
```

Expected: FAIL because `src/services/service.ts` and `ServiceRuntime` do not exist.

- [ ] **Step 3: 创建基础运行时**

Move these existing definitions from `src/arkme-service.ts` into `src/services/service.ts` without changing logic:

```text
StateStore
ArkmeServiceConfig
FetchLike
ArkmeEnvelope
ArkmeRemoteRequestOptions
ArkmePluginError
retryAfterMillis
joinUrl
joinUrlWithQuery
ServiceRuntime.requestService/requestScope/remoteServiceCooldownMs
ServiceRuntime.post/postDirect/get/getDirect
ServiceRuntime.requireSession/requireAuthFlowSession/refreshAccessToken
authenticatedAuthGet/authenticatedAuthPost/authenticatedSubjectPost
authenticatedChatPost/authenticatedBotPost/authenticatedWebrtcPost
authenticatedAudioPost/authenticatedRelationPost/authenticatedWorldPost/authenticatedIntelligentPost
```

Expose immutable runtime dependencies:

```ts
export class ServiceRuntime {
  readonly requestCoordinator = new ArkmeRequestCoordinator()

  constructor(
    readonly config: ArkmeServiceConfig,
    readonly sessionStore: ArkmeSessionStore,
    readonly stateStore: StateStore,
    readonly fetchImpl: FetchLike = fetch,
    readonly pendingSessionStore?: ArkmeSessionStore,
  ) {}

  dispose(): void {
    this.requestCoordinator.dispose()
  }
}
```

Keep pending-binding storage helpers in the runtime only until `AuthService` is extracted in Task 3; Task 3 becomes their final owner.

- [ ] **Step 4: Re-export compatibility types and error**

At the top of `src/arkme-service.ts`:

```ts
export { ArkmePluginError, type ArkmeServiceConfig } from './services/service.js'
import { ArkmePluginError, ServiceRuntime, type ArkmeServiceConfig } from './services/service.js'
```

Construct one runtime in `ArkmeService` with the existing constructor arguments. Replace internal HTTP/session calls with runtime calls, but keep all business methods and state in the façade for this task.

- [ ] **Step 5: 运行聚焦门禁**

Run:

```bash
pnpm vitest run tests/service-runtime.test.ts tests/service-architecture.test.ts tests/request-coordinator.test.ts tests/arkme-service.test.ts
pnpm run typecheck
```

Expected: PASS; `ArkmePluginError` identity tests and existing HTTP error assertions remain unchanged.

- [ ] **Step 6: 提交基础运行时**

```bash
git add src/services/service.ts src/arkme-service.ts tests/service-runtime.test.ts tests/service-architecture.test.ts
git commit -m "refactor(service): 功能点: 提取 Arkme 共享请求运行时"
```

---

### Task 3: 提取 AuthService 与 ProfileService

**Files:**
- Create: `src/services/auth-service.ts`
- Create: `src/services/profile-service.ts`
- Create: `tests/services/auth-service.test.ts`
- Create: `tests/services/profile-service.test.ts`
- Modify: `src/services/service.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-service.test.ts`

- [ ] **Step 1: 写直接 Service 失败测试**

Move one existing QR login case and one profile-cache case into direct tests:

```ts
it('keeps pending binding separate from the active session', async () => {
  const { runtime, sessions, pendingSessions } = authRuntimeFixture()
  const auth = new AuthService(runtime)
  const snapshot = await auth.pollWechatLogin('attempt-1')
  expect(snapshot.status).toBe('binding-required')
  expect(await sessions.read()).toBeUndefined()
  expect(await pendingSessions.read()).toMatchObject({ userId: expect.any(Number) })
})

it('single-flights profile refresh per user', async () => {
  const { runtime, fetchImpl } = profileRuntimeFixture()
  const profile = new ProfileService(runtime)
  await Promise.all([profile.refreshProfile(), profile.refreshProfile()])
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 运行测试确认模块缺失**

Run:

```bash
pnpm vitest run tests/services/auth-service.test.ts tests/services/profile-service.test.ts
```

Expected: FAIL because both service modules are absent.

- [ ] **Step 3: 迁移认证 owner**

Move to `AuthService`:

```text
attempts
pendingBindingSession
authStatus
beginWechatLogin/pollWechatLogin/testLogin
sendPhoneCode/verifyPhoneCode/logout
pending binding read/write/clear/accept helpers
authSnapshotForSession/profileHasBoundPhone/isPendingBindingSession
```

Keep credential refresh used by all domains in `ServiceRuntime`; AuthService owns only user-facing login/binding/logout workflow.

- [ ] **Step 4: 迁移 Profile owner**

Move to `ProfileService`:

```text
profileCache/profileInFlight/publicProfileCache/publicProfileAvatarCache
cachedProfile/refreshProfile
checkArkmeIdAvailability/setArkmeIdOnce
userCard
public profile batch readers and avatar projections
clientConfig/providerCapabilities/providerState
```

Export the narrow port:

```ts
export interface ArkmeProfileReader {
  refreshProfile(): Promise<ArkmeUserProfileSnapshot>
  userCard(userId: number, signal?: AbortSignal): Promise<ArkmeUserCardSnapshot>
  publicProfilesByUserIds(
    userIds: readonly number[],
    signal?: AbortSignal,
  ): Promise<Map<number, ArkmePublicProfile>>
}
```

- [ ] **Step 5: 显式 façade 委托**

Keep prototype methods:

```ts
async authStatus(): Promise<ArkmeAuthSnapshot> {
  return await this.auth.authStatus()
}

async refreshProfile(): Promise<ArkmeUserProfileSnapshot> {
  return await this.profile.refreshProfile()
}
```

Apply the same explicit pattern to every migrated public method; do not assign `this.auth.authStatus` directly.

- [ ] **Step 6: 运行测试并提交**

Run:

```bash
pnpm vitest run tests/services/auth-service.test.ts tests/services/profile-service.test.ts tests/arkme-service.test.ts tests/service-architecture.test.ts
pnpm run typecheck
git add src/services src/arkme-service.ts tests/services tests/service-architecture.test.ts
git commit -m "refactor(service): 功能点: 拆分认证与资料服务"
```

---

### Task 4: 提取 MediaService

**Files:**
- Create: `src/services/media-service.ts`
- Create: `tests/services/media-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-service.test.ts`

- [ ] **Step 1: 写图片缓存与账号作用域失败测试**

```ts
it('does not reuse an opaque image ref across accounts', async () => {
  const { runtime, switchUser } = mediaRuntimeFixture()
  const media = new MediaService(runtime)
  const imageRef = await media.sealProfileImageRef(1, 2)
  switchUser(3)
  await expect(media.readImage(imageRef)).rejects.toMatchObject({ code: 'image-ref-invalid' })
})
```

Run `pnpm vitest run tests/services/media-service.test.ts`; expect module-not-found failure.

- [ ] **Step 2: 迁移 Media owner**

Move:

```text
mediaRefs
imageCache/imageInFlight/imageCacheBytes/download concurrency
queryFileAssets/uploadLocalFile/fetchMedia/readImage
media descriptor, signed image, OSS credential and image type helpers
profile/world image ref sealing/opening used through narrow methods
```

Export:

```ts
export interface ArkmeMediaReader {
  readImage(imageRef: string, signal?: AbortSignal): Promise<ArkmeImageBytes>
  queryFileAssets(fileAssetUids: readonly string[], signal?: AbortSignal): Promise<ArkmeFileAssetDisplayItem[]>
}
```

- [ ] **Step 3: 委托、验证和提交**

```bash
pnpm vitest run tests/services/media-service.test.ts tests/arkme-service.test.ts tests/world-provider.test.ts
pnpm run typecheck
git add src/services/media-service.ts src/arkme-service.ts tests/services/media-service.test.ts
git commit -m "refactor(service): 功能点: 拆分媒体服务"
```

---

### Task 5: 提取 SourceService 与 ChatService

**Files:**
- Create: `src/services/source-service.ts`
- Create: `src/services/chat-service.ts`
- Create: `tests/services/source-service.test.ts`
- Create: `tests/services/chat-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-service.test.ts`

- [ ] **Step 1: 写 source ref 与发送失败测试**

```ts
it('rejects a source ref sealed for another user', async () => {
  const source = sourceServiceFixture({ userId: 1 })
  const page = await source.listSources('chat')
  const foreign = sourceServiceFixture({ userId: 2 })
  await expect(foreign.openSourceRef(page.items[0]!.sourceRef)).rejects
    .toMatchObject({ code: 'source-ref-invalid' })
})

it('preserves unknown-send results without automatic retry', async () => {
  const chat = chatServiceFixture({ upstreamFailure: 'timeout-after-write' })
  await expect(chat.sendSourceText('source-ref', 'hello')).rejects
    .toMatchObject({ retryable: true })
  expect(chat.upstreamCalls()).toBe(1)
})
```

- [ ] **Step 2: 运行测试确认模块缺失**

```bash
pnpm vitest run tests/services/source-service.test.ts tests/services/chat-service.test.ts
```

Expected: FAIL because both modules are absent.

- [ ] **Step 3: 迁移 Source owner**

Move `sourceListCache/sourceListInFlight/chatSourceCache`、source ref sealing/opening、`createTopic`、`listSources`、source list projection、avatar hydration and directory cache invalidation into `SourceService`.

Export:

```ts
export interface ArkmeSourceResolver {
  openSourceRef(sourceRef: string, expectedUserId: number): Promise<ArkmeSourceRefPayload>
  sourceItem(source: ArkmeSourceRefPayload): Promise<ArkmeSourceItem>
  invalidate(userId: number, directory?: ArkmeSourceDirectory): void
}
```

- [ ] **Step 4: 迁移 Chat owner**

Move:

```text
readSource/openPrivateChatFromUser
reportMessage/sendSourceText/sendSourceRich/sendDirectText/markSourceRead
chat timeline, forward preview and record-content projection used only by chat
message ref sealing/opening
```

Inject `ArkmeSourceResolver`, `ArkmeProfileReader` and `ArkmeMediaReader`; do not import concrete classes for runtime calls.

- [ ] **Step 5: 委托、验证和提交**

```bash
pnpm vitest run tests/services/source-service.test.ts tests/services/chat-service.test.ts tests/arkme-service.test.ts tests/realtime-events.test.ts
pnpm run typecheck
git add src/services/source-service.ts src/services/chat-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分来源与聊天服务"
```

---

### Task 6: 提取 GroupService 与 GroupAiPolishService

**Files:**
- Create: `src/services/group-service.ts`
- Create: `src/services/group-ai-polish-service.ts`
- Create: `tests/services/group-service.test.ts`
- Create: `tests/services/group-ai-polish-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-service.test.ts`

- [ ] **Step 1: 写 owner 与确认状态失败测试**

```ts
it('keeps AI polish confirmation account and source scoped', async () => {
  const polish = groupAiPolishFixture({ userId: 1 })
  const confirmation = await polish.prepareDisableGroupAiPolish('source-a')
  polish.switchUser(2)
  await expect(polish.confirmDisableGroupAiPolish(confirmation.confirmationRef))
    .rejects.toMatchObject({ code: 'ai-polish-confirmation-invalid' })
})
```

- [ ] **Step 2: 迁移 Group owner**

Move `listGroupMembers/groupSettings/setGroupMessageDnd/renameGroup/leaveGroup/dissolveGroup/reportGroup` and group avatar snapshot cache into `GroupService`.

- [ ] **Step 3: 迁移 AI Polish owner**

Move confirmations, retries, cache invalidation, notice/config reads, rule generation, enable/disable confirmation and AI-polished send orchestration into `GroupAiPolishService`. Inject a narrow raw chat-send Port:

```ts
export interface ArkmeRawChatSender {
  sendRaw(source: ArkmeSourceRefPayload, text: string, signal?: AbortSignal): Promise<ArkmeSourceSendResult>
}
```

- [ ] **Step 4: 验证和提交**

```bash
pnpm vitest run tests/services/group-service.test.ts tests/services/group-ai-polish-service.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/group-service.ts src/services/group-ai-polish-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分群组与智能润色服务"
```

---

### Task 7: 提取 ChatRealtimeService 与 OutgoingCallService

**Files:**
- Create: `src/services/chat-realtime-service.ts`
- Create: `src/services/outgoing-call-service.ts`
- Create: `tests/services/chat-realtime-service.test.ts`
- Create: `tests/services/outgoing-call-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/realtime-events.test.ts`
- Test: `tests/outgoing-call-broker.test.ts`

- [ ] **Step 1: 写生命周期失败测试**

```ts
it('stops projection timers and rejects late publications after dispose', async () => {
  vi.useFakeTimers()
  const realtime = chatRealtimeFixture()
  const stop = realtime.startChatRealtime()
  realtime.enqueueProjection('chat-1', 3)
  stop()
  await vi.runAllTimersAsync()
  expect(realtime.clientEvents()).toEqual([])
})
```

- [ ] **Step 2: 迁移 Realtime owner**

Move `ArkmeChatRealtimeRuntime`、listeners、projection maps/timer/retry counters、start/state/subscribe/initial event、notice batching and publication into `ChatRealtimeService`. Inject Source/Chat read Ports rather than façade.

- [ ] **Step 3: 迁移 Outgoing Call owner**

Move `ArkmeOutgoingCallBroker` and all request/claim/resolve/prepare/heartbeat/release methods into `OutgoingCallService`. Inject `ArkmeSourceResolver`、`ArkmeProfileReader` and runtime WebRTC calls.

- [ ] **Step 4: 验证和提交**

```bash
pnpm vitest run tests/services/chat-realtime-service.test.ts tests/services/outgoing-call-service.test.ts tests/realtime-events.test.ts tests/outgoing-call-broker.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/chat-realtime-service.ts src/services/outgoing-call-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分实时与通话服务"
```

---

### Task 8: 提取 RecordService、SearchService 与 RecordingService

**Files:**
- Create: `src/services/record-service.ts`
- Create: `src/services/search-service.ts`
- Create: `src/services/recording-service.ts`
- Create: `src/services/related-recording-service.ts`
- Create: `tests/services/record-service.test.ts`
- Create: `tests/services/search-service.test.ts`
- Create: `tests/services/recording-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/recording-host-api.test.ts`

- [ ] **Step 1: 写 outbox、cursor 和分页失败测试**

```ts
it('keeps an unknown create outcome pending for explicit retry', async () => {
  const record = recordServiceFixture({ timeoutAfterWrite: true })
  await expect(record.createText('record-1', 'hello')).rejects.toMatchObject({ retryable: true })
  expect(await record.pendingWrites()).toHaveLength(1)
})

it('rejects a recording cursor from another account', async () => {
  const owner = recordingServiceFixture({ userId: 1 })
  const cursor = await owner.sealRecordingCursor({ userId: 1, offset: 20 })
  const foreign = recordingServiceFixture({ userId: 2 })
  await expect(foreign.openRecordingCursor(cursor)).rejects.toMatchObject({ code: expect.any(String) })
})
```

- [ ] **Step 2: 迁移 Record owner**

Move cached snapshot/list/summary、refresh/sync history、create text、conversation create、pending writes/retry、longArticleDetail/updateLongArticle、long article draft Store calls and record projection into `RecordService`.

- [ ] **Step 3: 迁移 Search owner**

Move `searchRecords/searchRemote/searchHistory/createSearchHistory/searchScene/searchRecordings/queryCached` and search projection helpers into `SearchService`. Inject record/media readers as narrow Ports.

- [ ] **Step 4: 迁移 Recording owners**

Move calendar/day/transcript/projection/version/cursor into `RecordingService`; move eligibility/page/tool-event/private-source logic into `RelatedRecordingService`.

- [ ] **Step 5: 验证和提交**

```bash
pnpm vitest run tests/services/record-service.test.ts tests/services/search-service.test.ts tests/services/recording-service.test.ts tests/recording-host-api.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/record-service.ts src/services/search-service.ts src/services/recording-service.ts src/services/related-recording-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分记录搜索与录音服务"
```

---

### Task 9: 提取 WorldService、ArrangementService 与 InterwovenService

**Files:**
- Create: `src/services/world-service.ts`
- Create: `src/services/arrangement-service.ts`
- Create: `src/services/interwoven-service.ts`
- Create: `tests/services/interwoven-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/world-provider.test.ts`
- Test: `tests/arrangement-provider.test.ts`

- [ ] **Step 1: 写引用账号隔离失败测试**

```ts
it('rejects an arrangement ref sealed for another viewer', async () => {
  const owner = arrangementServiceFixture({ userId: 1 })
  const page = await owner.listArrangements('all')
  const foreign = arrangementServiceFixture({ userId: 2 })
  await expect(foreign.arrangementDetail(page.items[0]!.arrangementRef))
    .rejects.toMatchObject({ code: 'arrangement-ref-invalid' })
})
```

- [ ] **Step 2: 迁移 World owner**

Move world record/feed/interaction/publish/image projection and world ref caches into `WorldService`.

- [ ] **Step 3: 迁移 Arrangement owner**

Move list/detail/reminders/mutations/read/clear、write fence and both arrangement ref caches into `ArrangementService`.

- [ ] **Step 4: 迁移 Interwoven owner**

Move interwoven list/detail、private-source assertions、legacy fallback、moment ref and profile hydration into `InterwovenService`.

- [ ] **Step 5: 验证和提交**

```bash
pnpm vitest run tests/world-provider.test.ts tests/arrangement-provider.test.ts tests/services/interwoven-service.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/world-service.ts src/services/arrangement-service.ts src/services/interwoven-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分世界安排与交织服务"
```

---

### Task 10: 提取 WechatService

**Files:**
- Create: `src/services/wechat-service.ts`
- Create: `tests/services/wechat-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-service.test.ts`

- [ ] **Step 1: 写 cursor scope 失败测试**

```ts
it('does not reuse a message cursor across WeChat scopes', async () => {
  const wechat = wechatServiceFixture()
  const page = await wechat.listWechatConversations({ limit: 20 })
  await expect(wechat.readWechatMessages('conversation-ref', { cursor: page.nextCursor }))
    .rejects.toMatchObject({ code: 'wechat-cursor-invalid' })
})
```

- [ ] **Step 2: 迁移 WeChat owner**

Move conversation/message/detail/group member/phone/common group/money flow/location reads、wire projections、conversation refs and scoped cursors into `WechatService`.

- [ ] **Step 3: 验证和提交**

```bash
pnpm vitest run tests/services/wechat-service.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/wechat-service.ts src/arkme-service.ts tests/services/wechat-service.test.ts
git commit -m "refactor(service): 功能点: 拆分微信导入服务"
```

---

### Task 11: 提取 ArkoService、AiVideoService 与 BotService

**Files:**
- Create: `src/services/arko-service.ts`
- Create: `src/services/ai-video-service.ts`
- Create: `src/services/bot-service.ts`
- Create: `tests/services/arko-service.test.ts`
- Create: `tests/services/ai-video-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/arkme-bot-service.test.ts`

- [ ] **Step 1: 写 stream、模型 route 和 Bot secret 失败测试**

```ts
it('rejects an unregistered Arko model route before mutation', async () => {
  const arko = arkoServiceFixture()
  await expect(arko.arkoActivateModel('../invalid')).rejects
    .toMatchObject({ code: 'arko-model-route-invalid' })
})

it('never projects a raw Bot token in list results', async () => {
  const bot = botServiceFixture({ token: 'jbot_secret' })
  expect(JSON.stringify(await bot.listBots())).not.toContain('jbot_secret')
})
```

- [ ] **Step 2: 迁移 Arko owner**

Move profile/session/model catalog/history/ask/status/cancel、SSE reader/projection and Arko display-name cache into `ArkoService`.

- [ ] **Step 3: 迁移 AI Video owner**

Move preflight/create/status/list、text-video and segment selection/projection into `AiVideoService`.

- [ ] **Step 4: 迁移 Bot owner**

Move OpenClaw provisioner、Bot list/create/secret/chat/group membership、bot refs and connection metadata into `BotService`. Preserve provider fencing and secret redaction.

- [ ] **Step 5: 验证和提交**

```bash
pnpm vitest run tests/services/arko-service.test.ts tests/services/ai-video-service.test.ts tests/arkme-bot-service.test.ts tests/openclaw-provisioner.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/arko-service.ts src/services/ai-video-service.ts src/services/bot-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分 Arko 视频与 Bot 服务"
```

---

### Task 12: 提取 CommunityService 与 ExtensionReviewService

**Files:**
- Create: `src/services/community-service.ts`
- Create: `src/services/extension-review-service.ts`
- Create: `tests/services/community-service.test.ts`
- Create: `tests/services/extension-review-service.test.ts`
- Modify: `src/arkme-service.ts`
- Test: `tests/extensions/host-api.test.ts`

- [ ] **Step 1: 写 review outbox 和 community 状态失败测试**

```ts
it('keeps an unknown extension review write pending for reconciliation', async () => {
  const reviews = extensionReviewServiceFixture({ timeoutAfterWrite: true })
  await expect(reviews.createExtensionReview('extension-ref', { rating: 5, content: '好用' }))
    .rejects.toMatchObject({ retryable: true })
  expect(await reviews.pendingOperations()).toHaveLength(1)
})
```

- [ ] **Step 2: 迁移 Community owner**

Move `dshBetaCommunityEntryState/joinDSHBetaCommunity` and status mapping into `CommunityService`.

- [ ] **Step 3: 迁移 Extension Review owner**

Move author lookup、review list/create/outbox flush、rating projection、review refs and cleanup into `ExtensionReviewService`. Keep `extensionPost` as a public façade delegate to the runtime or review service according to the current caller; do not change its signature.

- [ ] **Step 4: 验证和提交**

```bash
pnpm vitest run tests/services/community-service.test.ts tests/services/extension-review-service.test.ts tests/extensions/host-api.test.ts tests/arkme-service.test.ts
pnpm run typecheck
git add src/services/community-service.ts src/services/extension-review-service.ts src/arkme-service.ts tests/services
git commit -m "refactor(service): 功能点: 拆分社区与扩展评价服务"
```

---

### Task 13: 收口 façade 与结构门禁

**Files:**
- Modify: `src/arkme-service.ts`
- Modify: `tests/service-architecture.test.ts`
- Modify: `tests/arkme-service.test.ts`
- Verify: `src/services/*.ts`

- [ ] **Step 1: 写 façade 收口失败测试**

Add:

```ts
it('keeps the facade free of business transport and state', () => {
  const source = readFileSync(join(root, 'src/arkme-service.ts'), 'utf8')
  expect(source).not.toMatch(/['"]\/api\//)
  expect(source).not.toMatch(/new Map<|new Set<|setTimeout\(/)
  expect(source.split(/\r?\n/).length).toBeLessThan(1_500)
})

it('keeps the shared runtime free of business routes', () => {
  const source = readFileSync(join(root, 'src/services/service.ts'), 'utf8')
  expect(source).not.toMatch(/['"]\/api\//)
})
```

Run `pnpm vitest run tests/service-architecture.test.ts`; expect FAIL while remaining business state/helpers exist in the façade.

- [ ] **Step 2: 删除已迁移的 façade 状态和 helpers**

Keep only:

```text
compatibility exports
constructor and service composition
143 explicit public method delegates
unified dispose
```

Remove unused business types/imports/constants/helpers from `src/arkme-service.ts`. Do not suppress unused code with lint comments or dummy reads.

- [ ] **Step 3: 验证所有目标业务文件存在**

Extend the structure test with the exact target file list from this plan. Assert every file exists and every `*-service.ts` avoids importing the façade.

- [ ] **Step 4: 运行全量静态和单元门禁**

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:call-assets
git diff --check
```

Expected: 全部通过；公开方法合同仍为 143 个；`src/arkme-service.ts` 小于 1500 行且无业务 path/state。

- [ ] **Step 5: 提交 façade 收口**

```bash
git add src/arkme-service.ts src/services tests/service-architecture.test.ts tests/arkme-service.test.ts
git commit -m "refactor(service): 功能点: 收口 ArkmeService 兼容门面"
```

---

### Task 14: 打包与未修改官方 DSH 验收

**Files:**
- Verify: `package.json`
- Verify: `lib/**`
- Verify: generated `.tgz` outside the repository
- No DSH source changes

- [ ] **Step 1: 运行最终门禁并记录测试数量**

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:call-assets
git diff --check
git status --short --branch
```

Expected: 全部通过，工作区干净，分支只包含本计划的原子提交。

- [ ] **Step 2: 生成不可变包并检查内容**

```bash
artifact_dir=$(mktemp -d /tmp/arkme-service-decomposition-artifact.XXXXXX)
pnpm pack --pack-destination "$artifact_dir"
tar -tzf "$artifact_dir"/*.tgz | sort
```

Expected: 包含 `lib`、声明文件、Bundle patch 和声明资源；不包含 `src`、`tests`、worktree 路径、凭据或计划文档。

- [ ] **Step 3: 建立临时 DSH_HOME 并安装 tgz**

Use the current supported, unmodified official DSH binary discovered from the runtime environment:

```bash
accept_home=$(mktemp -d /tmp/arkme-service-decomposition-dsh-home.XXXXXX)
accept_port=$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
DSH_HOME="$accept_home" dsh plugin --profile web add "$artifact_dir"/*.tgz
DSH_HOME="$accept_home" dsh web --port "$accept_port"
```

Expected: Profile dependencies and `dsh.profile.bundles` include the packed plugin; DSH starts without modifying its source checkout.

- [ ] **Step 4: 验证三消费面 smoke**

Verify against the temporary instance:

```text
Host API: auth.status returns the same logged-out/test-or-prod shape as baseline.
Tools: Arkme tool catalog registers with unchanged names and schemas.
SDK: ctx.arkmeData exposes providerCapabilities/providerState and the existing contract version.
UI: plugin client bundle loads without Host operation errors.
Realtime: connect/close leaves no heartbeat or projection timer after disposal.
```

Use existing Host/API/tool/SDK test helpers or a temporary local verification script outside the repository; do not add a product endpoint for acceptance.

- [ ] **Step 5: 核对 DSH 与目标分支状态**

```bash
git status --short --branch
git diff origin/master...HEAD --stat
dsh_bin=$(command -v dsh)
dsh_repo=$(git -C "$(dirname "$dsh_bin")" rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$dsh_repo" ]; then git -C "$dsh_repo" status --short --branch; fi
```

Expected: Arkme task worktree clean；DSH tracked state与开始时一致；diff 仅包含 Arkme 插件重构、测试和已批准文档。

- [ ] **Step 6: 提交验收说明（仅在仓库已有同类文档 owner 时）**

If the repository already records acceptance evidence in the active plan, append exact commands/results to this plan and commit only that documentation change:

```bash
git add docs/superpowers/plans/2026-08-20-arkme-service-decomposition.md
git commit -m "docs(architecture): 功能点: 记录 Service 解耦验收证据"
```

If no result text is added, do not create an empty commit.

---

## 完成检查

- [ ] `src/arkme-service.ts` 仅保留兼容 façade。
- [ ] `src/services/service.ts` 不含业务 path、投影、缓存或消费面方法。
- [ ] 设计中列出的全部业务 Service 已存在并拥有自己的状态。
- [ ] 143 个公开方法和构造方式保持兼容。
- [ ] Host、Tools、SDK、UI、Realtime 合同无变化。
- [ ] 业务 Service 不反向依赖 façade，不使用 façade 作为 service locator。
- [ ] 全量测试、类型检查、构建、资源校验和 `.tgz` 检查通过。
- [ ] 未修改的官方 DSH 临时 Profile 验收通过。
- [ ] 常驻 DSH、真实 Profile 和 DSH 源码 checkout 未被修改。
