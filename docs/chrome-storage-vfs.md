# ChromeStorageVfs API

`ChromeStorageVfs` 是基于 `chrome.storage.local` 的轻量文本文件系统。每个文件使用独立 storage key，目录由文件路径隐式形成。

## 创建实例

```js
import { chromeStorageVfs, createChromeStorageVfs } from "../src/utils/chromeStorageVfs";

// 默认共享实例，单文件上限 2 MiB
const fs = chromeStorageVfs;

// 自定义实例
const customFs = createChromeStorageVfs({ maxFileBytes: 512 * 1024 });
```

## 路径规则

- 路径统一规范化为绝对 POSIX 路径，例如 `projects\\demo` 会变成 `/projects/demo`。
- 支持 `.` 和 `..`，但不能越过根目录。
- 目录是隐式的，不需要 `mkdir`。
- 当前只支持 UTF-8 文本，不支持 `Uint8Array`、Blob、软链接和文件权限。

## Storage 索引

文件正文使用独立的 `vfs:file:{encodedPath}` key；`vfs:index` 只保存路径和 metadata：

```js
{
  version: 1,
  entries: {
    "/playgrounds/pg_123/style.css": {
      type: "file",
      path: "/playgrounds/pg_123/style.css",
      name: "style.css",
      size: 1024,
      lineCount: 48,
      expireAt: 1786873400000,
      revision: 3,
      createdAt: 1786787000000,
      updatedAt: 1786787300000
    }
  }
}
```

`stat`、`readdir`、路径冲突检查、递归删除和 rename 只读取索引，不加载文件 content。旧版本 VFS 没有索引时会执行一次 `chrome.storage.local.get(null)` 重建索引；索引建立后正常操作不再全量读取 extension storage。

每个文件记录和索引项都会持久化总行数 `lineCount`。整文件写入和所有范围编辑都会同步重算该值；VFS 索引升级时会从旧文件内容补齐它。

## 文件 API

### `readFile(path)`

读取完整文本，返回 `Promise<string>`。文件不存在时抛出 `ENOENT`。

### `readFileWithStat(path)`

在同一次 storage 读取中返回 `{ content, stat }`，适合需要基于 revision 做条件更新或删除的调用。

### `readFilesWithStats(paths)`

批量读取多个文件的一致 storage 快照，返回以规范化路径为 key 的 `{ content, stat }` 对象。

### `writeFile(path, content, options?)`

创建或覆盖完整文件。

```js
await fs.writeFile("/notes/today.md", "# Today", {
  expectedRevision: 0,
  overwrite: true
});
```

- `expectedRevision: 0` 表示只允许创建新文件。
- 传入已有 revision 可避免覆盖并发修改。
- revision 不一致时抛出 `ESTALE`。
- `overwrite: false` 且文件存在时抛出 `EEXIST`。
- 返回文件 stat。

### `readLines(path, options?)`

按 1-based 闭区间读取文本行。

```js
const result = await fs.readLines("/code/style.css", {
  startLine: 10,
  endLine: 15
});
```

返回：

```js
{
  path,
  content,
  startLine,
  endLine,
  lineCount,
  revision
}
```

### `applyPatch(path, patch)`

替换或插入指定行。

```js
await fs.applyPatch("/code/style.css", {
  startLine: 12,
  endLine: 12,
  content: "color: red;",
  expectedRevision: 3
});
```

- 省略 `startLine` 和 `endLine` 时替换整个文件。
- `endLine` 默认等于 `startLine`。
- `endLine = startLine - 1` 表示在该行前插入，不删除原行。
- `content: ""` 表示删除选中行。

### `editRange(path, edit)`

校验并原子替换一个连续的 1-based 闭区间，原内容和新内容都可以包含多行：

```js
await fs.editRange("/code/style.css", {
  startLine: 12,
  endLine: 14,
  originalContent: "color: red;\nmargin: 0;\npadding: 0;",
  newContent: "color: blue;\nmargin: 8px;",
  expectedRevision: 3
});
```

revision 或 `originalContent` 不匹配时不会写入任何内容。替换完成后会更新文件的 `lineCount`。

### `stat(path)`

返回文件或目录信息：

```js
{
  type: "file" | "directory",
  path,
  name,
  size,
  revision,
  createdAt?,
  updatedAt?
}
```

### `exists(path)`

判断文件或目录是否存在，返回 `Promise<boolean>`。

### `readdir(path, options?)`

列出目录内容。

```js
await fs.readdir("/playgrounds/pg_123");
await fs.readdir("/playgrounds", { recursive: true });
```

默认只返回直接子项；`recursive: true` 返回目录下所有文件。

### `unlink(path, options?)`

删除文件或目录。

```js
await fs.unlink("/notes/today.md");
await fs.unlink("/playgrounds/pg_123", { recursive: true });
```

非空目录未传 `recursive: true` 时抛出 `ENOTEMPTY`。删除不存在路径返回 `removed: 0`。

### `rename(oldPath, newPath, options?)`

移动或重命名文件、目录。

```js
await fs.rename("/notes/draft.md", "/notes/final.md", {
  overwrite: false
});
```

目标存在且不允许覆盖时抛出 `EEXIST`。

## JSON API

### `readJson(path)`

读取并解析 JSON。JSON 无效时抛出 `EBADJSON`。

### `readJsonWithStat(path)`

在同一次 storage 读取中解析 JSON，并返回 `{ value, stat }`。

### `writeJson(path, value, options?)`

使用两个空格缩进序列化并写入 JSON，支持与 `writeFile` 相同的 revision 选项。

## 监听 API

### `watch(path, listener)`

监听文件或目录下的 storage 变化，返回取消监听函数。

```js
const stop = fs.watch("/playgrounds/pg_123", event => {
  console.log(event.type, event.path, event.stat);
});

stop();
```

事件类型为 `create`、`change` 或 `delete`。

## 错误代码

- `ENOENT`: 文件或目录不存在
- `EEXIST`: 文件或目标路径已存在
- `EISDIR`: 尝试把根目录作为文件写入
- `ENOTEMPTY`: 尝试非递归删除非空目录
- `ESTALE`: expectedRevision 已过期
- `ERANGE`: 行范围无效
- `EFBIG`: 文件超过大小限制
- `EBADJSON`: JSON 内容无效
- `EINVAL`: 参数或路径无效
- `EPERM`: 禁止对根目录执行操作

## 当前存储布局

```text
/playgrounds/{projectId}/.project.json
/playgrounds/{projectId}/index.html
/playgrounds/{projectId}/style.css
/playgrounds/{projectId}/script.js
/stashes/{utf16TitleHex}.json
/webide/{projectId}/.project.json
/webide/{projectId}/package.json
/webide/{projectId}/index.html
/webide/{projectId}/src/**
```

旧的 `htmlPlaygroundProject:*` 和 `user_stashes` 数据会在首次读取时自动迁移。

## 文件生命周期

每个 VFS 文件的 metadata 都包含 `expireAt`。默认值 `-1` 表示永久保存；`writeFile` 和 `writeJson` 可传入绝对 Unix 毫秒时间戳。覆盖已有文件但不传 `expireAt` 时保留原过期时间。

Service worker 使用 `vfs-expired-file-cleanup` alarm 每 60 分钟扫描 VFS 索引。扫描和删除在同一个 VFS mutation lock 内完成，并通过一次 storage 更新删除所有已过期文件，避免并发写入留下只清理一部分的项目。

Playground 创建时会给 `.project.json`、`index.html`、`style.css` 和 `script.js` 设置同一个过期时间，默认创建后 24 小时。Stash 文件也把自身的 `expireAt` 写入 VFS metadata。因此两者由相同的 VFS alarm 主动清理；其他文件默认永久，除非写入时显式设置过期时间。

WebIDE 项目的 metadata、HTML、package.json 和源文件同样使用统一的项目过期时间。React 和 Vanilla JavaScript 项目由 sandbox 页面中的 `esbuild-wasm` 构建；相对导入从项目 VFS 解析，package.json 中固定版本的 npm 依赖通过 esm.sh 解析。
