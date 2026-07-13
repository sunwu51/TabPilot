# Tab Manager

Tab Manager 是一个面向重度标签页用户的 Chrome 扩展，目标是把“找标签、整理标签、保存工作现场、用 AI 操作浏览器”放到同一个侧边栏里完成。

## 当前功能

- 标签搜索：按标题和 URL 关键词搜索当前已打开的标签页，并同时补充最近浏览记录，方便快速切回页面或重新打开历史页面。
- 标签分组：支持按自定义正则规则分组，也支持一键按域名分组，还可以快速折叠全部分组或取消全部分组。
- 工作区保存与恢复：可以把当前打开的一组页面保存为工作区，之后一键恢复，恢复时会自动跳过已经打开的页面，减少重复标签。
- AI Agent：内置浏览器助手，可结合当前标签页、标签组、窗口、DOM 操作、历史记录等能力完成浏览器内的查询和操作。
- MCP / Skills 扩展：支持接入 MCP 工具和 skill-bridge，为 agent 增加额外工具能力。
- 截图工具控制：可以在设置中配置当前模型是否支持图片输入，决定是否向模型暴露截图能力。
- 会话与调度：agent 对话支持历史会话、导出，以及定时执行工具任务。

## 安装方式

Chrome 商店安装地址：

[https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec](https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec)

如果你不是使用 Chrome，或者希望自行修改源码，可以从 GitHub Releases 下载打包产物，然后通过浏览器开发者模式加载扩展。

## 开发说明

本项目基于 Vite + React。

常用命令：

```bash
npm install
npm run build
```

构建完成后，产物位于 `dist/` 目录。

## MCP 扩展接入

Agent 支持两种 MCP 接入方式：

- `HTTP`：填写 MCP 服务名称、HTTP URL，以及可选的 Headers JSON。
- `Extension`：填写一个名称和目标 Chrome 插件 ID，把另一个插件暴露的工具直接接入到当前小助手中。

### 在设置里添加 Extension 类型 MCP

1. 打开侧边栏里的 Agent。
2. 点击 `MCP` 按钮。
3. 在添加对话框里选择 `Extension`。
4. 填写：
   - `名称`：当前小助手里展示和命名工具时使用的前缀，建议只用字母、数字、下划线。
   - `插件 ID`：目标插件在 `chrome://extensions` 或其自身页面中显示的扩展 ID。
5. 点击连接。连接成功后，对方插件暴露的工具会自动加入当前会话。

如果报错 `Could not establish connection. Receiving end does not exist.`，通常表示目标插件当前没有成功接住外部消息。常见原因是：

- 插件 ID 填错。
- 目标插件未启用或刚更新后还没 reload。
- 目标插件的 background service worker 启动失败。
- 目标插件没有实现 `onMessageExternal` 或没有配置 `externally_connectable`。

## 如何开发一个可被接入的插件

如果你希望自己的 Chrome 插件能被 Tab Manager 以 `Extension MCP` 的方式接入，需要让它对外暴露一个基于 `chrome.runtime.sendMessage(extensionId, ...)` 的 JSON-RPC 2.0 接口。

### 1. Manifest 要求

目标插件需要在 `manifest.json` 中至少包含：

```json
{
  "manifest_version": 3,
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "externally_connectable": {
    "ids": ["*"],
    "matches": []
  }
}
```

说明：

- `background.service_worker` 用来接收外部扩展消息。
- `externally_connectable` 决定哪些扩展可以调用你。开发阶段可以像上面一样先放开；正式发布时更建议收紧到明确的调用方 ID。

### 2. Background 里监听外部消息

目标插件需要实现：

```js
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleJsonRpc(message).then((resp) => {
    if (resp) sendResponse(resp);
  });
  return true;
});
```

这里要点有两个：

- 接口要走 `onMessageExternal`，不是普通的 `onMessage`。
- 异步返回时要 `return true`，否则响应通道会提前关闭。

### 3. 协议规范

当前接入协议是一个轻量的 JSON-RPC 2.0 MCP 子集。Tab Manager 会向目标插件发送如下消息：

#### `initialize`

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26"
  }
}
```

响应至少应返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": { "tools": {} },
    "serverInfo": {
      "name": "your-extension",
      "version": "1.0.0"
    }
  }
}
```

#### `tools/list`

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

响应：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "your_tool",
        "description": "Tool description",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "required": []
        }
      }
    ]
  }
}
```

每个工具至少需要：

- `name`
- `description`
- `inputSchema`

其中 `inputSchema` 建议使用标准 JSON Schema object 结构。

#### `tools/call`

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "your_tool",
    "arguments": {
      "foo": "bar"
    }
  }
}
```

成功响应建议返回 MCP 常见的 `content` 结构：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "tool result"
      }
    ]
  }
}
```

当前 Tab Manager 会优先读取 `content` 中 `type: "text"` 的内容并拼接为工具结果。

### 4. 错误返回规范

当请求非法、方法不存在或工具执行失败时，建议返回标准 JSON-RPC error：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32601,
    "message": "Unknown method: tools/call"
  }
}
```

推荐约定：

- `-32600`：Invalid Request
- `-32601`：Unknown method / Unknown tool
- `-32602`：Invalid params
- `-32000`：业务执行失败

### 5. 最小实现建议

一个可接入插件通常拆成三层会比较清晰：

- `background.js`：负责 `onMessageExternal` 接线。
- `jsonrpc.js`：负责解析 `initialize`、`tools/list`、`tools/call`。
- `tool-impl.js`：真正执行浏览器能力或业务逻辑。

这样既方便本地调试，也方便后续同时复用到 WebSocket bridge、postMessage bridge 或别的入口。

## 参考实现

可以参考 [sunwu51/cookie-helper](https://github.com/sunwu51/cookie-helper)：

- 用 `externally_connectable + onMessageExternal` 暴露跨插件调用入口。
- 用统一的 JSON-RPC 2.0 handler 处理 `initialize / tools/list / tools/call`。
- 工具返回值使用 MCP 风格的 `content` 数组。

它是一个很小但完整的参考样例，适合直接照着实现第一版。

## 视频

[https://www.bilibili.com/video/BV1TsdZBmEo5](https://www.bilibili.com/video/BV1TsdZBmEo5)

[https://www.bilibili.com/video/BV1XKH7eEEM9/](https://www.bilibili.com/video/BV1XKH7eEEM9)
