# @puwenhui/dsh-rag-kb

DSH RAG 知识库插件：**文档导入 → 智能切块 → 本地向量化 → 混合检索（向量+FTS5）→ Reranker 精排 → 引用溯源**。

> 面向公司非技术人员的使用帮助请阅读 **[USAGE.zh.md](./USAGE.zh.md)**。

## 核心特性

- **混合检索**：语义向量（bge-small-zh）+ FTS5 trigram 关键词双路合并，同义/改述和精确词/错误码都能找到
- **Reranker 精排**（可选）：bge-reranker-base cross-encoder，对混合检索结果做语义精排，噪音过滤更准
- **GPU 加速**：DirectML（RTX 4060 实测批量索引快 4 倍），无 GPU 自动回退 CPU
- **引用溯源**：脚注式引用（正文上标¹²³ + 末尾参考来源清单），agent 回答自带出处
- **会话语义管理**：所有操作（添加/删除/保存/检索）直接在对话里用大白话完成
- **多格式支持**：pdf / docx / md / txt / csv / json
- **完全本地**：模型本地运行，数据不出机器
- **目录自动索引**：配置目录后文件放入/变更自动入库
- **对话内容保存**：把对话中的结论/总结一键存入知识库

## 版本要求

- **DSH ≥ 0.2.0**

## 安装

```sh
dsh plugin --profile web add @puwenhui/dsh-rag-kb
```

## 配置（设置 → 插件 →「知识库」标签页）

| 字段 | 默认 | 说明 |
|---|---|---|
| 知识库描述 | 空 | agent 检索前阅读，知道库里有什么 |
| 自动索引目录 | 空 | 放入文档自动入库（可选） |
| 检索返回条数 | 5 | 混合检索召回 top-K |
| 相似度阈值 | 0.3 | 0~1，过低噪音多 |
| 启用 Reranker | 关 | 开启后需下载 ~1GB 模型 |
| 重排后返回条数 | 3 | Reranker 精排后返回 top-N |

## 会话语义操作

| 你说 | agent 调用 |
|---|---|
| 「把 D:\docs 加进知识库」 | `knowledge_manage add` |
| 「把刚才的总结存到知识库」 | `knowledge_manage save` |
| 「知识库里有什么？」 | `knowledge_status` |
| 「删掉旧版手册」 | `knowledge_manage remove` |
| 「根据知识库回答：XXX」 | `knowledge_search` |

## 检索架构

```
文档 → 解析(pdf/docx/md) → 标题感知切块(节标题强制断块 + 400 token + 10% 重叠)
  → 向量化(transformers.js bge-small-zh-v1.5, 512维, GPU/CPU)
  → FTS5 trigram 关键词索引（与向量索引同步写入）

检索: 混合检索(向量余弦 + FTS5 bm25 双路合并, via=vector/keyword/both)
  → [可选] Reranker 精排(bge-reranker-base cross-encoder, 召回×3 → 精排 → top-N)
  → 引用溯源(citation + position 字段)
```

### 分块策略（v0.3.0 起）

面向 Markdown 手册/知识库文档优化，保证**一节 = 一块**，引用溯源可精确到节：

| 规则 | 说明 |
|---|---|
| 节标题强制断块 | 遇 `##` ~ `######` 立即断块，短节不再被合并；刻意不含单级 `#`——配置/代码注释普遍用它开头，误判会把命令序列切碎 |
| 续块补回节标题 | 长节切成多块时，每块都带节标题，检索命中时能看清出处 |
| 软下限 + 硬上限 | 块过短（如仅「节标题 + 来源行」）宁可略微超长也不单独成块；合并超过 1.2 倍上限则强制断开 |
| 滑窗按换行对齐 | 超长无结构段落按换行位置切分，不把命令行从中间截断 |
| 兜底宽度 | 块长控制在约 600 字符（≈400 token），实测上限 ~920 字符，避免超出 embedding 序列长度被截断 |

实测效果（13 篇技术/管理文档，114 节）：切成 605 块，**96% 的块带节标题**。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| Embedding | transformers.js + bge-small-zh-v1.5 ONNX | 512 维中文，本地 CPU 3.6ms/条 |
| Reranker | transformers.js + bge-reranker-base ONNX | cross-encoder 精排 |
| GPU 加速 | DirectML (device: 'dml') | 批量索引快 4 倍，无 GPU 回退 CPU |
| 向量库 | node:sqlite BLOB + 内存余弦 | 万级 chunk <50ms |
| FTS | SQLite FTS5 + trigram tokenizer | 中文 3 字滑窗精确匹配 |
| PDF 解析 | unpdf（纯 JS） | 无原生依赖 |
| DOCX 解析 | mammoth（纯 JS） | 无原生依赖 |
| 数据目录 | $DSH_HOME/rag-kb/ | index.db + hf-cache/ |

## 模型缓存

| 模型 | 大小 | 位置 |
|---|---|---|
| bge-small-zh-v1.5 | ~91MB | $DSH_HOME/rag-kb/hf-cache/ |
| bge-reranker-base | ~1GB | 同上（启用 Reranker 时自动下载） |

离线部署：管理员把整个 `hf-cache/` 目录拷贝到同事机器的相同位置即可。

## License

MIT
