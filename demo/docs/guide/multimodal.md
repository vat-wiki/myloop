# 多模态消息

SDK 使用自己的内部 block 格式。用户输入支持 `text`、`image`、`document` 和 `video`。

```ts
import { documentBlock, imageBlock } from "myloop";

await agent.run([
  { type: "text", text: "请分析这张图和这份 PDF" },
  imageBlock("image/png", {
    type: "base64",
    data: "iVBORw0KGgo...",
  }),
  documentBlock(
    { type: "url", url: "https://example.com/report.pdf" },
    "Quarterly report",
  ),
]);
```

视频可以这样表示：

```ts
await agent.run([
  { type: "text", text: "请理解这段视频" },
  {
    type: "video",
    mediaType: "video/mp4",
    source: { type: "url", url: "https://example.com/demo.mp4" },
  },
]);
```

## User Input Adapter

`SingleAgent` 会先用 User Input Adapter 把用户输入转换成 Runtime 认识的内部 block。默认规则是：

- 普通文本转换成 `text` block。
- `imageUrl` 和 `documentUrl` 保留为 URL source，不会自动下载。
- 本地文件默认禁止，必须显式开启。
- 本地文件会保存为 artifact 引用，不会把 base64 放进消息历史；未配置 `artifactStore` 时默认使用 `InMemoryArtifactStore`。
- URL 只接受 `http:` 和 `https:`。
- `maxLocalFileBytes` 限制单个本地文件；`maxTotalInputBytes` 限制一次输入中二进制内容的总大小。

```ts
const agent = new SingleAgent({
  name: "multimodal-agent",
  modelClient,
  input: {
    allowRemoteUrls: true,
    maxLocalFileBytes: 20 * 1024 * 1024,
    maxTotalInputBytes: 20 * 1024 * 1024,
    artifactStore, // 建议把同一个 store 传给 modelClient，用于解析 artifact
  },
});

await agent.run([
  "请分析这张本地图和这份远程 PDF",
  { type: "imageFile", path: "./diagram.png" },
  {
    type: "documentUrl",
    url: "https://example.com/report.pdf",
    title: "Quarterly report",
  },
]);
```

### Model Client Input Mapping

Runtime 不做模型输入能力协商，也不代表模型判断某个输入是否受支持。`messages` 会原样交给 ModelClient；每个协议 client 在自己的 `complete()` 中把内部 block 翻译成对应 API 格式。API 不支持某个输入时，由 API 返回错误。

如果本地文件被 User Input Adapter 存成了 artifact，协议 client 必须配置同一个 `artifactStore`，并在翻译请求时自己解析 artifact 引用。Runtime 不会在中间下载 URL 或转换 base64。

如果宿主应用需要完全控制文件读取、远程抓取或鉴权，可以注入自定义 adapter：

```ts
const agent = new SingleAgent({
  name: "multimodal-agent",
  modelClient,
  input: {
    async resolve(input) {
      // 把宿主应用的输入转换为 UserContentBlock 数组。
      return [];
    },
  },
});
```

当前 `Anthropic` 支持 image/document 映射，不支持视频输入；视频应由支持视频的 ModelClient 处理，或调用方先抽帧/转文字。
