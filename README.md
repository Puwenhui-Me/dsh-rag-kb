# @puwenhui/dsh-rag-kb

DSH RAG 知识库插件：**文档导入 → 智能切块 → 本地向量化 → 语义检索**，让 DSH 对话拥有私域知识。

> 面向公司非技术人员的使用帮助请阅读 **[USAGE.zh.md](./USAGE.zh.md)**。

## 核心特性

- **语义检索**：自然语言提问，agent 自动从知识库找答案（中文/英文均可）
- **多格式支持**：pdf / docx / md / txt / csv / json
- **完全本地**：向量化模型本地运行（bge-small-zh ONNX），数据不出机器
- **会话语义管理**：所有操作（添加/删除/保存/检索）直接在对话里用大白话完成
- **目录自动索引**：配置一个目录，文件放入/变更自动入库
- **对话内容保存**：把对话中的结论/总结一键存入知识库

## 版本要求

- **DSH ≥ 0.2.0**（依赖 settings 标签页体系与 volatile 字段机制）

## 安装

```sh
dsh plugin --profile web add @puwenhui/dsh-rag-kb
```

（源码宿主用 `pnpm dsh plugin --profile web add @puwenhui/dsh-rag-kb`）

## 配置

安装后打开 `dsh web`，**设置 → 插件 →「知识库」**标签页：

| 字段 | 说明 |
|---|---|
| 知识库描述 | agent 检索前阅读，知道库里有什么 |
| 自动索引目录 | 放入文档自动入库（可选） |
| 检索返回条数 | 默认 5 |
| 相似度阈值 | 0~1，默认 0.3 |

**首次使用**会自动下载中文向量化模型（约 100MB，下载后完全离线，模型缓存在 `$DSH_HOME/rag-kb/hf-cache/`）。

## 会话语义操作

所有知识库操作直接在对话里说，agent 自动调用对应工具：

| 你说 | agent 调用 |
|---|---|
| 「把 D:\docs 加进知识库」 | `knowledge_manage add` |
| 「把刚才的总结存到知识库」 | `knowledge_manage save` |
| 「知识库里有什么？」 | `knowledge_status` |
| 「删掉旧版手册」 | `knowledge_manage remove` |
| 「根据知识库回答：XXX」 | `knowledge_search` |

## 模型工具（3 个）

| 工具 | 说明 |
|---|---|
| `knowledge_search` | 语义检索：query + top_k → 带来源/相似度/原文的结果 |
| `knowledge_status` | 知识库状态：文档列表/配置/描述 |
| `knowledge_manage` | 管理操作：save / add / remove / reindex / describe |

## 技术架构

```
文档 → unpdf/mammoth 提取纯文本
     → 标题感知切块（400 token + 10% 重叠）
     → transformers.js 向量化（bge-small-zh-v1.5, 512 维, GPU 自动检测/CPU fallback）
     → node:sqlite 存储（chunk + 向量 BLOB）
     → 检索时内存余弦相似 top-K（万级 chunk 毫秒级）
```

- **向量库**：`node:sqlite`（Node 22.5+ 内置，零 npm 依赖，万级 chunk 内存检索 <50ms）
- **Embedding**：`@huggingface/transformers` + `Xenova/bge-small-zh-v1.5`（纯 JS ONNX，本地 CPU 3.6ms/chunk）
- **PDF 解析**：`unpdf`（纯 JS）| **DOCX**：`mammoth`（纯 JS）
- **数据目录**：`$DSH_HOME/rag-kb/`（index.db + hf-cache/）

## 已知限制

- 单库设计（不分知识库），适合 <1000 篇文档
- 512 维向量（bge-small-zh），如需多语言可换 bge-m3（1024 维）
- 附件出站（图片/文件回传 QQ）走路径文本，暂不支持直接推送

## 目录结构

```
src/           # 宿主半边（工具 + 索引 + 检索 + systemPrompt 注入 + SSE + 目录监视）
client-src/    # 浏览器半边（设置标签页）
lib/plugin.mjs # 宿主半边构建产物
lib/client.js  # 浏览器半边构建产物
cordis.patch.yml
```

## 开发

- 宿主半边：`npx tsdown`（产出 lib/plugin.mjs）
- 浏览器半边：`cd client-src && npm install && npm run build`
- 部署到本地 profile：构建后复制 `lib/plugin.mjs` 和 `lib/client.js` 到 profile 的 node_modules 目录
- 发布：bump version → `npm publish`

## License

MIT
