# Agent Hooks RFC

- 状态：Draft
- 版本：0.1
- 范围：TabManager Agent 生命周期、内置 hook 和外部扩展 hook
- 非目标：本 RFC 不定义插件 UI、插件打包格式，也不授予插件任意访问 TabManager 内部对象的能力

## 1. 摘要

Agent Hook 是挂在 Agent 生命周期事件上的异步回调。多个插件可以订阅同一个事件，并按确定的顺序链式执行。Hook 可以观察事件，也可以在开始阶段返回显式 `changes`，影响后续 Agent 执行。

Hook 的基本保证：

1. 单个 hook 报错、超时或返回非法结果时，记录诊断并跳过，不阻断后续 hook 和宿主主流程。
2. Hook 不直接修改宿主传入的对象；变更必须通过返回值中的 `changes` 表达。
3. 事件上下文是版本化、可序列化的 JSON 数据，不暴露函数、DOM、Chrome API、AbortController 或完整内部状态。
4. 只有开始阶段允许改变执行数据；结束、失败和取消阶段只观察。
5. 用户启用的本地插件视为完全信任：获得完整事件上下文，并可修改该事件的数据。
6. 环绕 hook 可以在一次执行范围内保存私有、短生命周期的 `state`；宿主只将该 state 回传给同一插件的对应结束回调，不持久化、不暴露给其他插件或 LLM。

## 2. 生命周期事件

事件名称使用 `<对象>.<阶段>`，阶段统一为 `before`、`after`、`error`、`cancel`。

### 2.1 Agent

| 事件 | 时机 | 是否可变更 |
| --- | --- | --- |
| `agent.run.before` | 创建一次 Agent run 后、首次 LLM 请求前 | 是：初始输入、运行附加数据 |
| `agent.run.after` | 最终回答持久化前 | 否 |
| `agent.run.error` | run 因异常结束时 | 否 |
| `agent.run.cancel` | 用户或系统取消 run 时 | 否 |

### 2.2 LLM

| 事件 | 时机 | 是否可变更 |
| --- | --- | --- |
| `llm.request.before` | 每次请求发送前，包括重试和 subagent 请求 | 是：请求消息、请求选项 |
| `llm.response.after` | 收到完整响应后、解析 tool call 前 | 否 |
| `llm.request.error` | 请求失败且即将重试或结束时 | 否 |

### 2.3 Tool

| 事件 | 时机 | 是否可变更 |
| --- | --- | --- |
| `tool.call.before` | 任何内置工具、MCP 工具、`exec` 内部工具调用前 | 是：工具参数；可返回 `action: "cancel"` |
| `tool.call.after` | 工具成功返回且完成内置结果转换后 | 否 |
| `tool.call.error` | 工具抛错或返回失败结果后 | 否 |

`tool.call.before` 必须位于所有工具的统一最低调用入口，因此普通工具、`exec` 嵌套工具和 subagent 工具调用都触发同一事件。`imgref/deref` 将作为两个内置 hook 接入该事件链：解析发生在 `before`，base64 登记和 ref 替换发生在 `after`。

## 2.5 环绕 Hook

对需要将开始阶段的上下文带到结束阶段的插件，使用环绕 hook，而不是让插件自行以 `callId` 将状态写入 storage。环绕 hook 的一次调用范围由宿主创建并保证配对：

```text
around.before(context) -> { changes?, state? }
  -> 主操作
around.after(context, state) | around.error(context, state) | around.cancel(context, state)
```

例如，审计插件可在 `before` 记录开始时间和参数摘要，并在 `after` 用同一份 state 生成耗时记录；追踪插件可在 `before` 生成关联 ID，并在 `error` 中补充错误标签。

环绕 hook 注册形态：

```json
{
  "event": "tool.call",
  "handler": "auditToolCall",
  "mode": "around",
  "priority": 100,
  "timeoutMs": 1000
}
```

`event: "tool.call"` 是环绕范围；它对应 `tool.call.before`、`tool.call.after`、`tool.call.error` 和 `tool.call.cancel` 四个观察点。第一版只要求 `tool.call` 与 `agent.run` 支持环绕模式，其他范围在有明确需求后加入。

### 2.4 Subagent、上下文和图片

支持以下事件：

- `subagent.run.before`、`subagent.run.after`、`subagent.run.error`
- `context.compact.before`、`context.compact.after`、`context.compact.error`
- `image.resolve.before`、`image.resolve.after`、`image.register.after`

图片事件提供 `img_*` 引用、媒体类型、字节数和来源。插件被用户启用即视为可读取完整上下文；第一版仍建议主流程内部使用引用传递图片，避免不必要地复制 base64 数据。

## 3. 通用事件信封

每次调用 hook 都收到一个事件信封。示例：

```json
{
  "schemaVersion": "agent-hook/0.1",
  "event": "tool.call.before",
  "eventId": "hev_01J...",
  "occurredAt": "2026-08-23T08:00:00.000Z",
  "source": "tabpilot",
  "session": {
    "id": "session_123",
    "windowId": 42
  },
  "run": {
    "id": "run_456",
    "parentId": null,
    "kind": "agent",
    "attempt": 1
  },
  "trace": {
    "traceId": "trace_789",
    "parentEventId": null,
    "depth": 0
  },
  "data": {}
}
```

字段约定：

- `eventId` 在一次事件发出时生成；重试会生成新的 `eventId`，但保留相同 `traceId`。
- `run.parentId` 用于标识 subagent 的父 run。
- `data` 是事件专属载荷，必须可 JSON 序列化。
- 时间、ID、session 信息只用于关联和审计，不应被插件当作业务状态持久化。

## 4. 事件数据结构

### 4.1 Tool 调用

```json
{
  "tool": {
    "name": "tab_navigate",
    "source": "builtin",
    "server": null,
    "callId": "call_123",
    "depth": 0
  },
  "args": {
    "tabId": 12,
    "url": "https://example.com"
  },
  "permission": {
    "required": false,
    "approved": true
  }
}
```

MCP 工具的 `source` 为 `mcp`，并提供 `server`；工具参数中的图片使用 `|deRef:img_1|`，不会自动展开为 base64。

`tool.call.after` 的 `data`：

```json
{
  "tool": { "name": "tab_screenshot", "source": "builtin" },
  "args": { "tabId": 12 },
  "result": {
    "success": true,
    "dataUrl": "|deRef:img_1|"
  },
  "status": "completed",
  "durationMs": 842
}
```

### 4.2 LLM 请求

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "request": {
    "apiType": "openai-compatible",
    "model": "example-model",
    "stream": true,
    "attempt": 1
  },
  "context": {
    "messageCount": 12,
    "estimatedTokens": 4800,
    "imageRefs": ["img_1"]
  }
}
```

启用的本地插件获得完整的 `messages`。这与用户自行安装、信任插件的模型一致。

### 4.3 Agent run

```json
{
  "input": {
    "messageId": "msg_1",
    "text": "整理当前窗口",
    "attachmentCount": 0
  },
  "config": {
    "apiType": "openai-compatible",
    "model": "example-model"
  },
  "state": {
    "messageCount": 1,
    "queuedMessageCount": 0
  }
}
```

完整消息内容、API key、Authorization header、cookie、data URL、页面原始 HTML 均不属于默认上下文。

## 5. Hook 返回值

Hook 必须返回 `undefined`、`null` 或一个返回对象。返回对象只允许以下字段：

```ts
type HookResult = {
  // 对本次主操作输入的修改。比如 { args: { url: "https://..." } }。
  changes?: object;
  action?: "continue" | "cancel";
  reason?: string;
};
```

- 未返回 `changes` 等同于不变更。
- `changes` 是“把当前事件 data 的哪些值改成什么”。它叫 changes 而不是 args，因为 Agent、LLM、上下文压缩等事件并不都有 `args`；在工具事件中，最常见的写法确实是 `changes: { args: ... }`。
- `action: "cancel"` 只对允许取消的事件生效。目前只有 `tool.call.before` 和 `agent.run.before` 支持取消。
- Hook 自己的调试输出直接使用插件环境的 `console.log`、`console.warn` 和 `console.error`；TabManager 不定义另一套 logs 返回协议。

环绕 hook 的 `before` 返回值额外允许 `state`：

```ts
type AroundBeforeResult = HookResult & {
  // 仅回传给同一个 pluginId + handler 的 after/error/cancel。
  // 这是随本次执行范围携带的私有数据，不参与后续 hook 的 changes 合并。
  state?: unknown;
};
```

环绕 hook 的结束阶段收到：

```ts
type AroundCompletionContext = HookEvent & {
  phase: "after" | "error" | "cancel";
  data: object;
  state: unknown | null;
};
```

`state` 是随本次执行范围携带的私有数据，不是全局上下文，也不用于修改主流程。宿主按 `(eventId, pluginId, handler)` 保存它，完成对应主操作后只回传给创建它的 hook。即使后续 hook 改了参数，或同一插件同时处理多个工具调用，state 也不会交叉。一次主操作结束、取消、超时或 run 释放时，宿主立即删除该范围内全部 state；它不进入会话记录、插件 storage 或 LLM 请求。

### 5.1 链式合并

对于可变事件，链式执行状态为：

```text
state_0 = 原始 data
data_n+1 = applyChanges(data_n, result_n.changes)
```

每个 hook 看到前序 hook 成功后的当前 data。changes 使用深合并：对象字段递归合并，数组整体替换，`null` 表示清空字段；宿主仍需拒绝 `__proto__`、`constructor` 或 `prototype`，避免对象原型污染。

对于环绕 hook，所有 `before` 仍依 priority 顺序先完成，再执行主操作；结束阶段按相反顺序执行。这与资源获取/释放一致，也允许外层 hook 覆盖完整内层耗时：

```text
A.before -> B.before -> main operation -> B.after -> A.after
```

`before` 失败的 hook 没有 `state`，也不调用其结束阶段。主操作开始后，任何结束阶段失败都只记诊断，不改变已经得到的主操作结果。

### 5.2 取消返回值

```json
{
  "action": "cancel",
  "reason": "domain blocked"
}
```

宿主将其转换为标准取消结果，不把插件错误暴露给模型：

```json
{
  "error": {
    "code": "HOOK_CANCELLED",
    "message": "Tool call was blocked by an enabled hook",
    "source": "hook"
  },
  "cancelled": true
}
```

## 6. 错误、超时和熔断

每个 hook 独立执行，默认超时 1500ms；事件可声明更严格的上限。以下情况均视为该 hook 失败：抛出异常、超时、返回非 JSON 值、changes 不是对象或结果超过大小限制。

失败结果：

```json
{
  "pluginId": "com.example.audit",
  "handler": "beforeToolCall",
  "status": "skipped",
  "error": { "code": "HOOK_TIMEOUT", "message": "..." },
  "durationMs": 1502
}
```

失败不会跳过其他插件。连续失败达到宿主配置阈值后，可暂时熔断该插件；熔断只影响该插件，不影响其他 hook。插件恢复或配置变化后清除熔断计数。

## 7. 插件声明和调用

插件通过现有 Chrome extension MCP 连接提供 hook 能力。发现和调用方法沿用 JSON-RPC 2.0，新增：

- `hooks/list`：返回插件支持的事件和声明的能力。
- `hooks/invoke`：宿主传入事件信封，插件返回 `HookResult`。

环绕 hook 的 `hooks/invoke` 请求分别使用 `phase` 区分开始和结束；`scopeId` 与事件 ID 相同，用于宿主审计，插件无需用它维护状态：

```json
{
  "event": "tool.call",
  "phase": "before",
  "scopeId": "hev_01J...",
  "context": {
    "schemaVersion": "agent-hook/0.1",
    "event": "tool.call.before",
    "data": { "tool": { "name": "tab_navigate" }, "args": { "url": "https://example.com" } }
  }
}
```

成功后，宿主在结束阶段仅对同一处理器发起：

```json
{
  "event": "tool.call",
  "phase": "after",
  "scopeId": "hev_01J...",
  "context": {
    "schemaVersion": "agent-hook/0.1",
    "event": "tool.call.after",
    "data": { "status": "completed", "durationMs": 842 }
  },
  "state": { "startedAt": 1787472000000, "auditId": "a_123" }
}
```

这里的 `state` 来自该处理器先前的返回值，不能由插件任意指定为其他 hook 的状态。`after`、`error` 和 `cancel` 不读取返回值；第一版不接受结束阶段的 `changes`，防止已经完成的操作被事后改变。

声明示例：

```json
{
  "id": "com.example.agent-hooks",
  "version": "1.0.0",
  "hooks": [
    {
      "event": "tool.call.before",
      "handler": "beforeToolCall",
      "priority": 100,
      "timeoutMs": 1000
    }
  ]
}
```

优先级数字越大越先执行；相同优先级按插件连接配置顺序，再按 `pluginId` 字典序稳定排序。启用的本地插件可读取和修改当前事件提供的完整 data；它们由用户信任，不在第一版引入权限或字段白名单。

## 8. 信任模型

- 所有插件调用都带有 `pluginId`、事件 ID 和审计诊断。
- 启用插件等同于用户信任该插件访问完整 Hook 上下文。它不适合承载来源不明的第三方代码。
- Hook 返回值仍必须可 JSON 序列化；插件不得通过返回值注入函数、Promise、循环引用或宿主对象引用。
- 宿主需要限制事件和返回值大小、执行超时，并拒绝原型污染路径，以保护 Agent 自身稳定性，而不是限制用户插件的业务权限。

## 9. 兼容性和版本

事件信封通过 `schemaVersion` 版本化。新增字段向后兼容；删除或改变字段语义必须提升主版本。未知事件和未知返回字段按“忽略并记录诊断”处理。

首个实现应固定 `agent-hook/0.1`，并提供纯内置 `HookBus` 测试，不要求插件存在即可运行 Agent。

## 10. 待决问题

1. 是否允许 hook 延迟工具调用等待用户确认，还是只允许同步式 `cancel`。
2. 是否需要为每个插件持久化状态，还是第一版只支持无状态回调。
3. 是否将 `llm.response.after` 的完整模型响应开放给插件，或只提供已归一化的响应对象。
4. 熔断阈值、事件 payload 大小和单次 run 的 hook 总预算。
