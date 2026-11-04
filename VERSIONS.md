# 智能读书助手 — 版本历史

## v2.1.1 — 2026-11-04（左栏改目录常驻，会话改抽屉）
- **布局对调**（慧姐指定）：书内三区从 `[会话侧栏|阅读区|AI区]` 改为 **`[目录侧栏|阅读区|AI区]`**——读书时翻目录比翻历史会话高频，目录常驻左栏（toc 层级/降级平铺 + 本书全文搜索 + 底部书籍摘要，可收起为 36px 细栏，开合态持久化）；会话改顶栏唤出的**左侧满高抽屉**（与工具/收藏同款镜像，按钮带计数角标；新建/选中会话后自动收起）
- 组件变更：新建 TocRail.jsx（自原 BookReader 内联 TocDrawer 迁移+侧栏化，搜索跳转后自动回目录列表）、SessionDrawer.jsx（列表渲染复用旧 SessionRail 逻辑）；**删 SessionRail.jsx 与 BookReader 内联 TocDrawer**；顶栏「目录」按钮语义=侧栏开合、「会话」=唤出抽屉
- 持久化键迁移：`reader_ui.railOpen`（原会话栏）→ `tocRailOpen`，读取时旧键一次性回落
- E2E 同步：e2e_mindmap 会话隔离改为「先开抽屉再点新对话」+新增"会话抽屉打开/新对话后自动收起"断言（23→25）；e2e_v20_browser 目录断言从"抽屉开+背板关"改为"默认展开/可收起/可再展开"侧栏三断言
- 教训重现：Edit 报"old 与 new 完全相同"实为文件字节本就正确、显示层把 `flex-shrink-0` 渲染变形——ASCII 类名核验也必须 repr/正则，肉眼与"记忆中的原文"都不可信

## v2.1 — 2026-11-04（存档点：思维导图 M1——JSON 结构树 + 零漏章 + 按需展开）
- **JSON 结构树协议**：导图产出从 markdown（markmap 渲染）改为 JSON 树 `{t,c[],cid}`，artifact 帧 `{type:"mindmap"}`（工具流）/`{type:"mindmap-subtree"}`（展开流）；前端自绘树（连接线/折叠箭头/展开态本地 state），旧 markdown 落盘数据嗅探 `trim().startsWith('{')` 兼容走 markmap 降级路径
- **零漏章架构（核心）**：全书按 8 章/组生成三级骨架，主题回填按 `_norm_title` 归一化匹配（含唯一包含兜底+去重截 40 字），**章节点由 `_build_book_tree` 逐真实 chroma 章节组装**——LLM 漏写/改写/幻觉章节名均不影响节点集合（《非暴力沟通》实测 16/16 章，幻觉章被 `_themes_from_response` 过滤）
- **max_tokens 透传实锤**：langchain-openai 1.3.3 源码无条件把 `max_tokens` 改名 `max_completion_tokens`（`_default_params`/`_get_request_payload` 两处），DeepSeek 不认该参数→旧导图输出被默认上限截断漏章。**唯一可靠 = `llm.bind(extra_body={"max_tokens": 8192})`**（OpenAI SDK 原样并入请求体；实测传 20 则输出恰 20 tokens、finish_reason=length）
- **按需展开**：`POST /api/tools/mindmap/expand/stream`（book_id+chapter_id，404 校验含跨书）生成章→主题→论点→论据四级子树，服务端锚定 `node.t=章标题/cid`；前端展开成功以子树整体替换该节点 children 并自动展开；单章直出同样是四级树（论据锚定原文，实测质量佳）
- **工具抽屉范围切换器**：标题下"范围"换成 `[当前章|整本书]` 分段控件（`data-testid="tool-scope"`，无当前章时禁用），替换原静态提示文字；`scope` 兜底逻辑收口到 App.handleRunTool
- **孤章悬案（陈年 bug 定位+三层兜底）**：《非暴力沟通》books_index 17 章但 chroma 仅 16——首章（译序前）向量从未写入，`/books/chapters/{id}` 404 → 进书永卡"章节加载中"、单章工具静默回退整本书。修复：①前端 `loadError` 显式渲染"本章内容缺失"（不再永卡）②后端 scope 回退时发 status 说明帧"当前章内容未入索引，范围已自动回退为整本书"③数据层重建该章向量**仍属 P1 待做**
- **E2E 会话隔离教训**：进书自动恢复该书最近会话（含专家绑定）→工具产出会落进旧会话、追问被专家人格劫持。脚本必须先点 `button[title="新对话"]` 隔离；新增"章节加载有终态""已重置为新对话"断言
- **测试**：pytest 64 passed（新增 `tests/test_mindmap.py` 18 项：JSON 提取/节点清洗/树组装含幻觉过滤/全书两组帧序/单章锚定/双败降级 markdown/展开端点 404 与帧协议）；`tests/e2e_mindmap.cjs` Playwright 浏览器级 **23 断言全绿**（真实 LLM：16 章树渲染=跳转=展开按钮数、默认可见=章+1、跳原文章头一致、主题层/按需展开、放大浮层开关、落盘 output_type=mindmap 且树章数与界面一致、基于导图追问）
- **日期更正**：v1.9/v1.9.1/v2.0/v2.0.1 条目原标 2026-11-09/11-10 系既往会话时钟漂移错误，按 git log 实测（四者均 2026-11-03 提交）更正；memory 目录同期存在 2026-11-09/11-10 幽灵日志文件
- 已知限制：展开态存组件本地 state，刷新后丢失（持久化留 P1）；工具结果缓存未做

## v2.0.1 — 2026-11-03（工具/收藏改顶栏抽屉 + E2E 防残留加固）
- **工具抽屉**：慧姐反馈"细栏没标题认不出"——撤常驻 36px ToolRail，改顶栏「工具」唤出右侧满高抽屉（标题"AI 工具"+范围提示，5 工具逐行图标+名称+说明，作者对谈内联输入，运行后自动收起、产出进对话流）；书内布局变为三区 `[会话侧栏|阅读区|AI区]`，阅读区更宽
- **收藏抽屉**：顶栏「工具」旁新增「收藏」开关（带计数角标），独立右侧满高抽屉（标题+计数、勾选导出 txt、hover 删除、空态）；工具抽屉内原底部收藏入口移除
- **E2E 加固（两轮崩溃换来的）**：① 上轮崩溃残留的测试会话会让落盘断言秒"假绿"、刷新掐断本轮流式报 network error → 脚本先取基线会话集，落盘/追问/清理只认本轮新增；② reload `waitUntil` 从 networkidle 改 load（并发 LLM 流下永不收敛）；③ catch 必须 `browser.close()` 否则孤儿 chromium 堆积。断言 18→20（+收藏抽屉开/关），全绿；游子吟测试会话清零
- 教训：BSD grep 的 `\b` 同样静默失效（与 `\|` 并列），核验一律 python re 或 hex 比对；本轮 hex 逐字节再次证明"API 名笔误"系显示层假象
- 新文件 ToolDrawer/FavoritesDrawer.jsx，删 ToolRail.jsx；README 页面节同步；dist 随仓库提交

## v2.0 — 2026-11-03（存档点：前端全面重构——书架首页 + 书内四区 + 产出即消息）
- **两级页面（hash 路由）**：`#/` 书架首页（设计感占位封面：书名/作者衬线排版 + 按 book_id 哈希的 12 对渐变色块 + 书脊线，零外部依赖；卡片显示"读到 ×章"+进度条，无进度显示字数；整页拖拽上传 + 右下角进度浮层；hover 删除）→ `#/book/{id}` 书内。刷新/前进后退/深链直达均正常
- **书架全局语义搜索**：`/search/semantic` 400ms 防抖，结果卡显示 `{相似度×100}% 相关`（relevance_score 即相似度，直接映射），点击直达该书该章
- **书内四区**：`[会话侧栏 216px | 阅读区 flex-1 | AI 区 400px | 工具细栏 36px]`，各区可独立收起为 36px 图标细栏（AI 区流式时收起态图标带脉冲点）；开合状态持久化 `reader_ui`；<1280px 默认收起 AI 区
- **阅读区双栏书页**：容器实测宽 ≥900px 自动 `.book-columns`（CSS columns:2 + column-rule，<980px 媒体查询回落单栏）；判定用 **useState 回调 ref + ResizeObserver**（useRef+[] deps 会错过异步挂载的章节、永不过 observe——真 bug 教训）；摘要条全宽置顶不受分栏影响；章头带字数、上/下一章翻页、换章回顶
- **章节目录 = 顶栏「目录」抽屉**：左满高抽屉，toc 层级渲染（匹配率<0.8 降级平铺，逻辑迁移自旧 LeftPanel）+ 本书全文搜索 `/search/fulltext` + 底部书籍摘要
- **产出即消息（核心架构变更）**：AI 工具产出不再是独立面板，而是 `kind:"tool"` 消息流进对话时间线——卡头 ⚡工具名+范围+流式状态点，正文块化渲染（表格/列表转换迁移自旧 RightPanel）、mindmap 走 markmap 全屏浮层、HTML artifact 内嵌 iframe 浮层+下载、完成后可收藏；**可直接被追问**（buildHistory 中 tool 消息截断 600 字带【AI 工具产出·名称】标签，html 产出只留一行占位）
- **后端配套**：`POST /sessions/{sid}/messages` 落盘端点（role/kind 白名单校验、空内容 400）；`chat_store.append_messages` 支持 tool 元数据白名单落盘（tool_id/tool_name/output_type/filename/scope）；会话以工具产出开场时用工具名兜底标题（`×× · 工具产出`）
- **多书进度**：`reading_progress_map`（localStorage，旧 `reading_progress` 自动迁移），书架与进书恢复各自章节
- **组件重构**：新建 App.jsx（路由/状态中枢）+ Bookshelf/BookReader/ReadingPane/AiPanel/SessionRail/ToolRail/ToolMessageCard/tools.js 八件套；删除 LeftPanel/MiddlePanel/RightPanel 三件套；vite proxy 补 `/sessions` `/experts`
- **踩坑记录**：① PDF 提取书普遍无空行，`split(/\n\n+/)` 整章成一个巨型 block，`break-inside-avoid` 让 CSS columns 无法内部断栏→双栏右列全空；修复=无空行时退化按单 `\n` 切段 + 长块（>300 字）不再禁止断行 + 标题行 `break-after:avoid`。② 类名/标识符肉眼核验不可信（本版本多次"看到"的笔误实为显示错觉），唯一可信=构建+浏览器 E2E+截图，终极=源码 className token 与产物 CSS 交叉比对（0 缺失）
- **测试**：pytest 46 passed（+tool 落盘/端点校验 5 项）；`tests/e2e_v20.py` API 级 28 断言；`tests/e2e_v20_browser.cjs` Playwright 浏览器级 16 断言（书架/搜索/进书/双栏含右列文字流动实测 425 字/抽屉/工具流式落盘 1062 字/刷新恢复/追问/无 JS 报错）
- 已知限制：<1280px 窄屏靠收起 AI 区腾宽；工具产出收藏仍走旧 favorites（未随会话归档）；对比阅读已于 v1.9.1 下线

## v1.9.1 — 2026-11-03（对比阅读下线，输入区改为显示模式切换）
- **删除对比阅读**：前端模式按钮组/cross 面板/左栏多选勾选全移除；后端 `ChatRequest.selected_book_ids` 字段与多书检索分支移除（旧客户端带该字段仍 200 忽略，不 500）；`chat_store` 的 scope 存储机制保留（cross 白名单兼容存量数据，注释标遗留）
- **输入区按钮组改显示模式**：中栏"阅读/对话"两态——阅读=章节卡片（摘要+原文+书籍摘要），对话=纯消息流+参考来源；发消息/进专家/收束报告/切历史会话自动跳对话，选书回阅读
- 会话作用域简化为按书隔离（scopeKey 不再有 cross 全局桶）；42 passed；冒烟：单书问答 137 字+5 sources 落盘、旧字段兼容、专家×3 正常、cross 列表 0 条

## v1.9 — 2026-11-03（存档点：专家模式——方法论主导的读书，不是一次性提示词）
- **设计分野**："回合归谁"判据——工具 = 一次性 AI 干活；专家 = 方法论主导多轮回路（AI 提问/挑毛病/攻击，读者做认知工作）。每个专家必须带完整方法论三要素 `system`（回合规则）/`opening`（起手式）/`report`（收束报告），缺一即"提示词马甲"拒绝加载
- **文件化专家包**（规范参照 WorkBuddy 专家包 v2.0 精简版）：`backend/app/experts/<id>.json` 落文件即生效（热扫描）；展示字段（花名/职业/方法论/tags×3/quickPrompts×3）与提示词分离，`GET /experts` 不外发提示词
- **内置三专家**：`socrates` 苏格拉底（产婆术·只问不答，逐轮打最弱一环）、`feynman` 费曼（学习检验·你讲他挑，术语关/因果链/例子关 + 清晰度评分）、`munger` 芒格（反过来想·压成可证伪命题后经济学/心理学/概率三镜审问）
- **链路**：`POST /experts/{id}/opening` 按当前范围生成第一回合并建会话落盘（`kind:"opening"`）；`/analysis/chat/stream` 加 `expert_id`（会话绑定后可省略）做 system prompt 换轨，默认读书助手人格不变；`POST /experts/{id}/report` 读会话全程 SSE 流式生成认知诊断（落盘 `kind:"report"`，无读者回答时 400）
- **前端**：输入框左侧"＋"二级级联菜单（一级分组留扩展位，二级 WorkBuddy 式专家卡）；专家状态条（方法论标签 + 收束报告/退出按钮）；quickPrompts 建议条（过滤"收束："类，由按钮承担）；report 专属卡片；历史列表专家徽标；会话切换/恢复/删除全程同步 `activeExpertId`
- **弱工具下线**：`background` 背景调研、`recommend` 书籍推荐删除（泛化搜索类，不基于馆藏内容）；工具收敛至 5 个
- **测试同步**：`test_chat_sessions` 的 fake_stream 签名补 `system_prompt_override`；沙箱内 pytest `tmp_path` 撞陈旧基目录用 `--basetemp` 隔离；全量 42 passed
- 实测 E2E（《魔鬼家书》第三章，新书真实数据）：起手式 6 个递进问题且声明"只提问不回答"规则；两轮含糊回答均被逐轮追问（每轮仅 1 个聚焦问题、引用出处「《书名》·章节名」）；收束报告 420 字直斥"用表态替代分析"不美化；旧弱工具 404；空对话收束 400

## v1.8 — 2026-11-03（存档点：AI 工具重设计 P0——流式 + 范围收口 + 三处真 bug）
- **全量流式**：`POST /api/tools/{tool_id}/stream` SSE 端点统一执行（帧协议：status/content/sources/artifact），前端逐 token 渲染，全书总结带"通读全书 i/n 段"进度帧；旧非流式 `POST /api/tools/{tool_id}` 下线
- **范围收口**：工具作用范围 = 左栏当前选中章（未选中即整本书），不再让用户打字描述范围；面板头部显示"范围：××"
- **统一上下文构建**：单章全文直进（12000 字封顶）；全书按预算逐章分配限额、首尾都取、覆盖每一章（替代旧"前 20 章 × 2000 字"截断）；全书总结改 map-reduce（8 章/块提炼 → 汇总）
- **修 bug①辩论空谈**：`debate`（完全不注入书中内容的跨学科辩论）改造为 `author-talk` 与作者对谈——问题先经语义检索 6 段原文 grounding，AI 以作者第一人称回答并标注出处章节，结果区回显引用章节
- **修 bug②导图错位**：废弃"第X章"正则猜编号（游子吟 61 章扁平编号必错位），改为把选中范围内章节真实标题列表写进 prompt 锚定二级节点——实测 13/13 逐字一致
- **修 bug③总结范围打架**：删掉打字输入与实际选中章的语义冲突，统一走 scope
- **改名**：知识图谱 → 精读笔记（名实相符；HTML 后端拼装留 P1 改 JSON+前端渲染）
- 实测：单章总结 725 帧流、对谈引用第三章真实小诗、全书 map-reduce 进度帧正常；旧端点 404；全量 42 passed

## v1.7 — 2026-11-03（存档点：对话历史持久化）
- **会话存储**：`chat_store.py` 单文件 JSON（原子写盘 + 线程锁 + 毫秒单调时间戳），会话按 scope 隔离（单书挂 book_id / 对比阅读全局桶）；标题自动取首问前 24 字
- **`/sessions` CRUD**：列表（瘦身版带 message_count、按更新时间倒序）/ 新建 / 详情 / 删除；删书级联清理会话
- **流式接口自动落盘**：`/analysis/chat/stream` 接受 `session_id`——用户消息先行落盘（刷新/断流不丢提问），回答完成后补写 assistant 消息（含 RAG 来源）；无效 session_id 静默降级不影响流
- **前端会话 UI**：对话区新增"＋新对话 / 历史(n) 下拉"（切换、删除、当前高亮）；消息从 React 内存态改绑后端会话，**刷新页面自动恢复该书最近一次对话**；首次提问才惰性建会话（不堆空会话）
- **顺手修**：SSE 帧解析补了半截行缓冲（TCP 切帧时 JSON.parse 会静默吞掉答案的问题）
- 测试 +7（store 单测 + 端点函数直调的落盘集成测试，绕开 TestClient/httpx 版本坑）：全量 42 passed；端到端真实问答验证落盘（57 帧流、5 来源、标题、删除）通过

## v1.6.1 — 2026-11-03（修复：解析后章节顺序与原书一致）
- **目录页掩码**：`_mask_toc_pages` 在锚定前把目录区块（≥3 个目录标题成串出现）替换为等长空白（偏移不破坏），章节不再错锚到书前部目录页——修复《非暴力沟通》"第一章排在译序/前言之前、前言引言垫底"的乱序
- **prose 保护**：目录块紧跟正文标题（EPUB 常见，如游子吟"…修订版前言⏎前言⏎正文"）时，行后两行内出现长句判定为真实标题不抹，防掩码过杀
- **父子标题合并**：`_merge_nested_anchors` 处理锚点相邻（<60 字）——章标题行下紧接小节标题（如"第一章 让爱融入生活"+"引言"仅隔 11 字）时删层级更深者，父章吸收其内容，父章不再被 50 字过滤整章丢弃
- **存量重建**：`scripts/resplit_book.py` 用索引已存 TOC 重切分 + 本地 bge 重建向量，零 LLM 成本；EPUB 原生目录书自动跳过；旧索引自动备份
- 三本书顺序全部对齐原书；游子吟目录页切出的假"简介"章（内容为目录行）顺带清除；全量 35 passed
- **前端目录渲染修复**：LeftPanel 走 toc 层级渲染时按的是 AI 生成顺序（译序/前言被排在第十三章之后）——toc 按 chapters 真实顺序重排后渲染，无对应章节的 toc 项（已并入父章的"引言"等）过滤；dist 已重建

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
