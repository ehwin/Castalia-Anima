# SillyTavern · Castalia Anima 聊天记忆

酒馆自带 Vector Storage 的聊天向量开关、Summarize 的暂停，以及第三方 MCP 客户端，均不能直接实现 Anima 的逐聊天项目绑定和消息版本同步。本适配器在扩展设置中提供详细选项，并在输入框左侧提供一键聊天开关。

## 使用

1. 在 Anima 根目录执行 `npm run build`。
2. PowerShell 执行 `./integrations/sillytavern/install.ps1 -TavernRoot '你的/SillyTavern目录'`。
3. 酒馆 `config.yaml` 设置 `enableServerPlugins: true`，重启酒馆。
4. 扩展面板打开 **Castalia Anima · 聊天记忆**，点击“检查连接”。
5. 在输入框左侧点击脑形记忆按钮即可开启当前聊天记忆；按钮高亮表示开启。从新消息开始记录。需要导入旧对话时，到扩展设置点击“导入当前聊天”。

关闭后停止该聊天的召回和同步，已保存的记忆保留。关闭期间的新消息默认不加入记忆，重新开启时可选择导入。新聊天、复制分支默认关闭并使用新项目。聊天改名也会生成新项目并关闭；第一版不提供跨聊天共享或改名迁移。

后端配置在 `<SillyTavern>/plugins/castalia-anima/config.json`：

```json
{
  "engineRoot": "<path-to-Castalia-Anima>",
  "bankDir": "<path-to-memory-banks>/sillytavern",
  "embedMode": "none"
}
```

默认文本检索，无外部 API。需要语义检索时将 `embedMode` 改为 `ollama`，可设置 `ollamaUrl`、`embeddingModel`，或在独立 bank 的 config.json 配置嵌入服务。修改后重启酒馆。嵌入失败会记录日志并尝试文本回退，下一次同步重试待嵌入记录。每次同步最多 5000 条消息。

## 数据和边界

- 用户身份来自酒馆服务端 `req.user.profile.handle`，不接受浏览器指定。`project = st_ + SHA1([用户, 聊天身份])`；单聊身份包含角色卡文件名，群聊包含群组 ID。
- 复用 Anima 普通版继承的项目分库，默认使用独立 bank，不连接 AIRI/Full 的已有库。
- `tavern_sync` 按消息稳定 ID 事务同步选中的文本：编辑/续写/切换 swipe 替换旧版，删除停用原记录，同时移除旧向量，防止后续召回弃用版本。
- 生成前 await 同步、检索，按 tokenizer 的 token 预算注入。静默生成/代写用户跳过记忆注入。最近四条消息从召回结果中排除。
- 不调用 `auto_process`、digest、情绪/画像/反思管线，避免未补齐的全局状态隔离影响多角色。第一版提供原始历史召回，不承诺关系提炼、自动情绪或长期摘要。
- 提示词保持酒馆角色卡、世界书和当前剧情优先，不注入引擎的编程指令种子。
- 关闭不会删除已有数据；关闭时已发出的同步请求可能完成。正在流式生成时关闭后，下一次生成不再注入，当前已经发送给模型的内容无法撤回。
- 第一版不自动清理删除整个聊天后遗留的项目，也不支持跨标签页同时编辑同一聊天。插件卸载可删除本插件的两个安装目录，bank 数据独立保留。

## 参考核查

- [酒馆自带 Vector Storage](https://github.com/SillyTavern/SillyTavern/tree/release/public/scripts/extensions/vectors)
- [酒馆自带 Summarize](https://github.com/SillyTavern/SillyTavern/tree/release/public/scripts/extensions/memory)：暂停自动摘要不等于停止注入。
- [SillyTavern MCP Client](https://github.com/bmen25124/SillyTavern-MCP-Client) + [Server](https://github.com/bmen25124/SillyTavern-MCP-Server)：支持 stdio/SSE/HTTP 工具，但需要工具调用能力，未发现自动 Anima 项目和归档适配。
- [Horae](https://github.com/SenriYuki/SillyTavern-Horae)：自己的剧情记忆系统，有模块开关；README 未提供 Anima 后端适配。

上述结论基于官方代码及插件 README 核查，未运行第三方插件。验证命令：`node --test integrations/sillytavern/tests/*.test.mjs`。
