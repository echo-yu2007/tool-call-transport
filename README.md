# Tool Call Transport

这是从用户提供的“拉刻西斯 V1.72”预设中独立提炼出的 SillyTavern 前端扩展。

它只保留以下核心机制：

- 将上下文装入只读工具的 `description`；
- 可将当前用户输入包装成一次已有的工具结果；
- 强制模型通过输出工具返回完整正文；
- 将 OpenAI 兼容格式或 Gemini 原生格式的工具调用还原成普通助手正文；
- 强制非流式响应，避免工具参数在流式传输中被截断。

它不会读取、启用、禁用或修改任何预设提示词，不使用 `[[SERVE_TRIGGER]]`，也不包含酒杯、侍酒师、酒馆订单、拉刻西斯角色替换、随机噪声或悬浮球。

## 安装

在 SillyTavern 中打开“扩展”→“安装扩展”，粘贴：

`https://github.com/echo-yu2007/tool-call-transport`

也可以把仓库复制到：

`SillyTavern/public/scripts/extensions/third-party/tool-call-transport/`

然后重启或刷新 SillyTavern，在“扩展”设置里找到 **Tool Call Transport**。

## 设置

- **启用请求改写**：总开关。关闭后请求完全原样放行。
- **渠道策略**：自动识别 Google 原生渠道，也可以手动强制。
- **上下文放入工具说明**：关闭时只添加输出工具，不重排消息。
- **包装当前输入为工具结果**：仅在上下文工具模式开启时生效。
- **强制指定输出工具**：建议开启；部分不完整的兼容端若拒绝具名 `tool_choice`，可关闭后使用 `auto`。

## 注意

- 这是纯前端扩展，无 npm、服务器插件或酒馆助手依赖，但必须运行在 SillyTavern 中。
- 它会改写聊天补全请求，并将 `stream` 设为 `false`。
- 各反代对工具调用格式的支持不同；遇到 HTTP 400 时，先切换渠道策略或关闭“包装当前输入为工具结果”。
- 扩展只处理 `/api/backends/.../generate` 请求，不改写 tokenizer、模型列表或其他请求。
