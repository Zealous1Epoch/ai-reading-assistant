# 智能读书助手 — 版本历史

## v1.6 — 2026-11-03（存档点：RAG 检索质量升级）
- **中文 embedding 上线**：废弃 ChromaDB 默认英文 MiniLM，接入本地 ONNX 版 `bge-small-zh-v1.5`（onnxruntime + tokenizers，CLS pooling + L2 归一化），数据不出机器、零调用费；模型经 `scripts/download_embedding_model.py` 一次性下载（不入库）
- **章节滑窗切块**：整章一向量 → 650 字滑窗块（重叠 130 字防跨块断句），块元数据保留 chapter_id/chunk_index/prefix_len；检索命中即返回整块上下文，废掉"章首 300 字"截断
- **cosine 空间 + 诚实打分**：新集合 `book_chapters_v2` 用 cosine 距离；relevance_score 改为真实余弦相似度；`search_max_distance` 阈值把明显无关内容挡出 LLM 上下文；prompt 增加"参考内容无关时须声明书中未涉及"兜底
- **阅读/工具链路适配**：`get_chapter_by_id`、`get_full_chapters`（AI 工具整书分析）、fulltext 全文搜索均改为"块→章"按序拼回（剥离重叠前缀，实测无重复文字）
- **重建零 LLM 成本**：`scripts/rebuild_vectors.py` 直接读旧集合整章正文重切块入库；馆藏 3 本 1224 块重建完成；清理掉测试残留《我的试验小品》
- **质量回归**：黄金问题集 10 问（3 本真实藏书，top-3 期望关键词断言）+ 切块单测 6 个 + 无关查询反例；全量 35 passed
- 实测对比：《非暴力沟通》"怎样表达感受"从章首截断噪声 → top1 直接命中"第四章 体会和表达感受"

## v1.5 — 2026-11-03（存档点：上传与解析链路完善）
- **上传加固**：分块流式写盘 + SHA-256 内容去重（索引存 `content_hash`，`/upload` 与解析阶段双重查重，重复上传返回 `duplicate:true`）；单文件大小上限（默认 200MB，超限 413）；空文件拒收；扩展名白名单
- **文件真实性校验**：python-magic 优先 + 零依赖文件头魔数兜底（`.pdf` 须 `%PDF`、`.epub` 须 `PK`、`.txt` 内容实为 PDF/zip 时拒收），伪装文件不再进库
- **TXT 编码自动探测**：BOM → utf-8 → gb18030 → big5 → shift_jis → utf-8 replace 兜底 + 私用区字符占比启发式防误判，GBK 文件上传不再 500/乱码
- **EPUB 原生目录切分**：优先读 NCX/nav 目录（`book.toc` 映射 spine），零 AI 成本精确切章；锚点 <2 时降级原 AI+正则方案
- **解析健壮性**：空章节保护（明确报错"文件可能已加密/为空/扫描版缺 OCR"）；重解析先删旧向量实现幂等；修复 fallback 目录去重误合并真实 bug（`Chapter 1`/`Chapter 2` 曾被并为同章，改为按编号去重）
- **路径解耦**：`PROJECT_ROOT` 绝对锚定 uploads/data，不再依赖启动 CWD；`.env` 多余键容忍（`extra="ignore"`）；修复 `datetime.now` 可变默认值
- **失败可见**：解析失败状态置 `failed` 并带错误信息，前端轮询短路，不再空等 10 分钟；TXT 书名为 UUID 时用原始文件名回填显示名
- **批量上传**：批内 hash 互斥 + 并发信号量限 3 + 响应新增 `duplicates` 数组
- **存量数据治理**：`scripts/cleanup_data.py`（支持 `--dry-run`）——孤儿文件按 EPUB 元数据认领回归、按 hash 去重、孤儿进废纸篓（`/usr/bin/trash`）、清理 ChromaDB 无主章节、回填 content_hash；馆藏整理为 3 本干净数据
- **测试**：venv 补装 pytest/pytest-asyncio（此前测试从未真正执行过），新增编码探测/EPUB 原生目录等 5 个用例，全量 18 passed

## v1.4 — 2026-11-03（存档点）
- 前端从 CDN + Babel Standalone 迁移至 Vite + Tailwind 构建（`frontend/src/`，产物 `frontend/dist/` 随仓库提交供 Docker 部署）
- `main.py` 静态服务重写：优先服务 dist 构建产物，新增路径安全校验（防目录穿越）
- 补充 npm 脚本 `dev/build/preview`
- 冒烟测试通过：前端构建、页面服务、书籍列表、全文搜索、语义搜索
- `.gitignore` 加固：`.env` 备份文件、工具目录不入库

## v1.3 — 2026-05-29
- GitHub Pages demo 页面
- Demo 使用说明更新
- Demo 脚本 & 章节切分优化
- 标签：`d90d1a7`

## v1.2 — 2026-05-13
- Railway 部署配置完善（Dockerfile、Procfile、runtime.txt）
- 修复 Railway 兼容性问题
- 前端跨域兼容
- 标签：`2a1a615`

## v1.1 — 2026-05-04
- Railway 部署配置
- 环境变量配置更新
- API 路径相对化
- 标签：`9e28791`

## v1.0 — 2026-05-04
- 初始版本：智能读书助手
- 标签：`109ef19`
