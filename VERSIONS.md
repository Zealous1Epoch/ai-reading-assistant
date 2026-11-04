# 智能读书助手 — 版本历史

## v2.8 — 2026-11-04（播客提速提质：并发合成 + 语义缓存 + 台本审核——30 分钟档 ~5min→~1.5min，同主题复跑 0 秒）
- **A 并发合成**（`tts_service.stream_synth` 重写）：串行 ~3s/段（30 分钟档 60+ 段要等近 5 分钟，瓶颈全在逐段等微软往返）→ `Semaphore(4)` 段级并发；所有防线原样保留——段级 3 试、单段字节先进内存**整段成功才收**、全部成功后按台词顺序拼字节原子落盘（完成序≠台词序，进度计数语义不变；代价整片内存缓冲，30 分钟档 ~10MB 可接受）；消费方提前断开（SSE 断连）`finally` 取消在跑任务、不留半成品。实测 10 分钟档 41 段全程 46s（v2.5 同档需 ~2min）
- **B 缓存语义修正**：v2.5 键含台本哈希——LLM 每次重写台本、重跑必不命中，缓存形同虚设。改 `podcast_audio_name(书, 主题, 时长, nonce="")`（版本前缀 v3），**命中判定提前到 RAG/LLM 之前**：同主题复看 0.0 秒即时返回、完全不动 LLM 额度（时长从成品字节反推，48kbps=6KB/s）；`ToolRequest.regen`（时间戳 nonce 另起新一期、不覆盖旧文件）；前端播客面板新增「重新生成一期」开关（`data-podcast-regen`，默认关）
- **C 音频拟真**：语速 `+9%` 透传 edge-tts（贴真实对谈节奏、顺带压缩成片）；段间插 ~264ms 微停顿给轮次呼吸感（仅段间，片头片尾不加）。**本机无 ffmpeg**——静音帧按规范纯 Python 构造：MPEG-2 LSF Layer III、48kbps/24kHz/mono、LSF 帧长=72×br/sr=**144B**（L3 帧长 144×br/sr 是 MPEG-1 专属公式，记错会构造出双倍长废帧）、side info 全零 → part2_3_length=0 解码纯静音；帧头取 edge-tts 实测值 `FF F3 64 C0`，经 AudioToolbox 回环验证（standalone 0.264s；真帧+静音混合反解 51 块=20+11+20、静音区样本峰值 0）
- **D 台本审核**（`validate_script` 五规则，返回问题清单）：段数下限（目标字数/200）／总字数 <60%（**腰斩档硬失败**——宁可报错不发时长注水的货）／>135%／单条 >120 字／同人连说占比 >20%；不合格把问题清单追加进提示词定向重写（初稿+最多 2 次重掷，进度帧透明），残余小瑕疵走「先照常合成」软着陆。qwen 实测新提示词下初稿即过审
- **E 提示词增强**：悬念/生活场景钩子开场（禁"今天我们聊聊"报幕腔）、每个观点顺带标注出自哪一节（照抄段落标注章节名）、口语语感 few-shot（标注内容严禁照抄）、结尾一句话预告下期、段数下限明示
- **时长口径修正**（真实冒烟抓出）：edge-tts 中文口播实测 ~290 字/分，原常数 240 致 10 分钟档实际只出 **6.2 分钟**；且首轮标签按字数估、复用分支按字节算，同一期两个数字。改 `PODCAST_CHARS_PER_MIN=280` + 首轮标签在合成完成后统一用成品字节反推——复测 10 分钟档实际 **9.0 分钟**
- **测试**：pytest **127 passed**（新增并发保序/瞬断重试恢复/三试全败不留 .part/消费方断开即取消/rate+gap 透传/`validate_script` 六例/缓存复用+regen 帧协议例）；`e2e_audio.cjs` 加 regen 开关三连断言（默认关→高亮→回关）并**温跑兼容**（该章 mp3 已在盘时状态条断言放行"缓存直出播放条"），**18/18**；真实三轮实测 miss 46s → hit 0.0s → regen 60s（新文件名新期），资产与音频自清理
- 踩坑：① 跨段替换用"通用起始锚（多个工具函数共有的 `prompt = f"""` 行）+ re.S 非贪婪 + 唯一收尾锚"会**把中间整段函数定义吞进替换区**（本会话吞掉 `_questions` 等、import 期 NameError 才暴露）——必须从唯一收尾锚**反向行级定位**起始行；② 传输层会把代码里的路径分隔符静默同化（点↔斜杠互换后 `ast.parse` 照样通过——斜杠形态是合法除法表达式），需 grep 行回显 + `chr(47)` 拼接构造替换串裁决；③ 测试断言里 `b"中文"` 直接 SyntaxError（bytes 字面量仅 ASCII），期望值用 `"...".encode("utf-8")`，且经正则捕获组搬运原文避免手打中文

## v2.7 — 2026-11-04（鼠标划线高亮 + 选区引用进对话——阅读区第一次能「指给 AI 看」）
- **锚定设计（核心决策）**：不用字符偏移——`cleanChapterContent` 渲染前会剥页码/乱码行/压缩空格，偏移与渲染文本必然对不上。改存 `{chapter_id, start_p(段落块 data-p 索引), text(选区原文)}`，渲染时对每块做**去空白 indexOf 匹配**包 `<mark class="hl-mark" data-hl>`（原文偏移映射：逐字符建 norm→raw 索引表，空白不参与匹配但切片还原原文）；匹配不到优雅跳过——书重切/文本改版后划线自然失效但**绝不错位标半截**。跨段选区按渲染叶子 `<p>` 逐段拆分入库（`textOffsetIn` 把 Range 端点映射进叶子纯文本偏移，含已包 mark 的子节点也准）
- **后端**：`highlight_store.py`（chat/card 同款单文件 JSON+锁+原子写；text cap 2000；同书同章同段同文去空白**幂等去重**——重复划线返回既有条目）+ `routers/highlights.py` 4 端点（POST 验章存在并自动补 `chapter_title`）+ main 注册 + **删书级联** `delete_for_book`（挂资产级联之后）+ `GET /highlights/count` 预留书架徽标
- **选区操作条**：ReadingPane `mouseup` → `collectSelection()`（滚动容器内 `[data-p] p, p[data-p]` 叶子 ∩ `range.intersectsNode`）→ 视口坐标浮层 `data-sel-bar`：**划线 / 加入对话 / 复制** 三键（`onMouseDown preventDefault` 防点按钮时选区被清）；点已有划线弹 `data-hl-menu`（取消划线/加入对话）；滚动即收起浮层
- **引用进对话（不动服务签名）**：`ChatRequest.quote {text, chapter_id}` → **路由侧**拼 `读者在书中划了一段（出处：《章题》）：「…」\n\n读者的问题：…` 喂 `stream_chat`（教训执行：给服务函数加参数要同步全部测试 fake，能不碰就不碰）；摘录并入 RAG query 提升检索相关性；未带问题时后端兜底「请帮我解读这段摘录。」。落盘：`chat_store.append_messages` 白名单加 `quote` 字段、`AppendMessageRequest` 同步加——用户消息 content 只存问题本体、引用独立字段（含 chapter_title），刷新恢复气泡渲染 `data-msg-quote` 琥珀引用块；`buildHistory` 把带引用的历史消息前缀摘录文本，追问时模型知道"这段"指什么
- **前端状态**：App 持 `highlights`（进书 GET、增删乐观+对账）与 `quoteDraft`（切书/切会话/删除会话即清；发问即清 chip）；AiPanel 输入框上方 chip（90 字截断+出处+可移除）、发送钮允许**只发引用不带问题**；`/highlights` 进 vite proxy
- **测试**：pytest **115 passed**（新增 `test_highlights.py` 8 项：字段/空文拒收/幂等去重/cap/过滤/计数/删除/级联 + 路由直调 400·404·补章题·往返）；`e2e_selection.cjs` **17/17 零 LLM**——程序化 Range+mouseup → 操作条 → 划线 mark 与 API 对账 → **reload 持久** → 点 mark 取消 → chip 出现/移除 → API 注入带 quote 的会话消息 → reload 选会话渲染 `data-msg-quote` → 自清理；真实 LLM 冒烟：quote+提问 854 字回答直扣摘录语义、落盘 quote 含章题、RAG 5 来源正常
- 踩坑：① JSX 用了 `doCopy` 但函数漏定义——**vite build 不报**，浏览器渲染期 ReferenceError 才炸（React 整树卸载、浮层不出现），浏览器 E2E 第一时间拦住：静态构建不是 UI 功能的终点判据；② SessionDrawer 会话条目是 `div.group` 整行 onClick 而非 button，E2E 猜选择器落空 30s 超时——**读组件源码再写断言**；③ E2E api helper 从此带状态码诊断（非 2xx 打印响应体），防 JSON.parse 出 undefined 静默续跑
- 已知边界：划线是"存在即渲染"级匹配，同一段内完全相同的重复句会先匹配到前者（可接受）；书架徽标 count API 已留、UI 未接；划线批注笔记/多色分类/汇总导出为后续方向

## v2.6 — 2026-11-04（LLM 换成公司内部部署——DeepSeek → qwen3.8-flash-next @ vLLM，零代码换源 + 三处严格性适配）
- **换源兑现"只改 .env 三行"承诺**：`config.py` 三变量 `deepseek_api_key/base_url/model` 全走环境变量、两处 `ChatOpenAI`（`analysis_service`/`ai_service`/`book_processor`）本就是通用 OpenAI 兼容客户端。仅改仓库根 + `backend/` **两份** .env：`DEEPSEEK_BASE_URL=http://110.90.4.74:26030/v1`、`DEEPSEEK_MODEL=qwen3.8-flash-next`（与 WorkBuddy 会话同模型）、key 与公司招聘系统共用（均 gitignored、明文不入仓库，`.env.example` 只留内部端点模板）。变量名 `DEEPSEEK_` 前缀**保留不改**（历史兼容，避免全仓 import 震荡）
- **推理模型/vLLM 严格性逼出三处真适配**（都是"换端点才暴露的既有隐患"）：
  1. **全局关思考**：4 个 `ChatOpenAI` 构造器加 `extra_body={"chat_template_kwargs":{"enable_thinking":False}}`——qwen3.8-flash-next 默认开思考，会把 `max_tokens` 预算吃光导致 JSON 输出腰斩（公司招聘系统 2026-10-16 事故同款教训）；平铺 `enable_thinking` 被 vLLM 忽略，**只认 `chat_template_kwargs` 嵌套写法**（curl 实锤 `reasoning_tokens:0`）
  2. **bind 整体替换语义**：`tools._bounded_llm` 用 `.bind(extra_body=...)` 传 `max_tokens`，而 langchain_openai 的 payload 构建是 kwargs 覆盖 default——bind 的 extra_body 会**整体替换**构造器上的，故 `max_tokens` 与 `chat_template_kwargs` 必须并进同一个 dict，否则关思考失效
  3. **中位 SystemMessage → AIMessage**：`stream_chat` 拼接 RAG 上下文时用了假 `SystemMessage("好的，我已了解…")` 做占位；vLLM 严格校验"system 消息只能在首位"直接 400 `System message must be at the beginning`，DeepSeek 此前容忍所以从未暴露——语义本就是 assistant 应答，改 `AIMessage`（全仓 grep 确认仅此一处非首位）
- **顺带硬化 `stream_synth`（v2.5 遗留可靠性）**：段级重试（首试 + 2 次、间隔 1s）。真实播客首次合成在第 25/48 段撞 edge-tts `No audio was received`（微软端偶发断流，与换模型无关——LLM 台本已正常产出 48 段）；关键：单段音频**先缓冲进内存、整段成功后才写入文件**，否则中途失败重试会把半段脏字节静默混进拼接 mp3（爆音/拒播且不抛异常，最难查）
- **全量真实 LLM 回归（内部模型，替换此前被 402 欠费阻塞的 #35）**：`v20_browser` **24/24**（含真实工具产出落盘 847 字 + 追问落盘）、`e2e_mindmap` **25/25**（全书 16 章结构树 + 按需展开 + JSON 落盘 2021 字 + 基于导图追问）、`e2e_citations` **12/12**（真实问答 11 个 `[n]` 句内引用、编号均对应真实 sources、点击跳章高亮）、`e2e_cards` **16/16**（真实抽卡 8 张全归所选章）、`e2e_assets` **21/21**（零 LLM）、真实 `cards/stream` 冒烟 JSON 完整、真实播客 64 段双声合成产出 mp3 + 自动归档资产区；pytest **107 passed**
- 卡片 E2E 首跑 `评分落盘 box=2` FAIL 与换模型无关：该测试**非自包含**——依赖外部预置的"非暴力沟通第三章 8 张种子卡"（作者注释自述），且本会话真实 `cards/stream` 冒烟（产出即入库）往**魔鬼家书**落了 8 张卡抢占全局复习队列首位，而评分断言去非暴力沟通库找 `front0` → 跨书落空。清残留 + 重建第三章基线后 16/16。教训固化：**冒烟工具调用在共享 `data/` 库留真实副作用，跨书 UI 测试前必须清场**
- **文档/表述**：README、`.env.example`、`ReadingPane` 注释全面去 DeepSeek 字样改「公司内部部署大模型（OpenAI 兼容 / vLLM）」；文档改动一律 python 码点布尔探针裁决字节（沿用显示层字形抖动铁律）
- 已知边界：变量名仍叫 `DEEPSEEK_*`（纯历史包袱，语义已泛化为「OpenAI 兼容端点」）；内部端点 `http://110.90.4.74:26030` 须在公司内网/VPN 内可达

## v2.5 — 2026-11-04（听书 + 读书播客——edge-tts 免费语音，双主播定制时长）
- **语音层 `tts_service.py`（edge-tts 7.3.1，微软在线神经网络语音）**：免费、无独立 key、**完全不依赖 DeepSeek 余额**；男声 `zh-CN-YunxiNeural` / 女声 `zh-CN-XiaoyiNeural`；`clean_for_tts` 剥 markdown 行首符/内联符/分隔线、压空白，超 2 万字截断并补口语化收尾；缓存文件名 sha1(范围|书|章|正文哈希)——内容未变秒回，重切章自动失效；成品落 `data/audio/`（已 gitignore）
- **章节听书 `/audio` 3 端点**：POST /chapter（孤章 404、空章 400；已缓存直接 `{done,url,cached}`，否则 `asyncio.create_task` 后台合成返回 task_id）→ GET /task/{id} 轮询 → GET /file/{name}（限定 40 位 hex 防路径穿越，`audio/mpeg`）。任务表纯内存：重启丢任务无妨，成品在盘上重新请求即命中
- **播客 = 第 7 个 SSE 工具 `podcast`**：`user_input`=主题、`minutes`∈10/20/30（目标字数=分钟×240）；流程 = `search_chapters` 检索 6 段（未命中回落 `_context` 全书预算上下文）→ `_llm_json` 产台本 `{"lines":[{"s","t"}]}` → `lines_from_obj` 规范化（s 容错 A/B/女、空台词剔除、无有效台词报 error 帧）→ `stream_synth` 逐段双声合成**同文件顺序写入**（同码率 mp3 帧拼接直接可播）每 5 段发进度 status → `artifact {type:"audio", data:url}`；**新成品自动归档资产区**（`output_type="audio"`，归档失败不挡播放；缓存复用/合成失败不存）
- **前端**：① 章头「听本章」按钮 + 播放条（ReadingPane 本地状态机 idle/busy/ready/err；`listenReqRef` 换章竞态保护——后台任务不取消因为成品落盘、回来秒播；autoPlay 经用户手势链合法）② ToolDrawer 播客内联面板（主题输入 + 10/20/30 档 chips；共享 talkOpen 重构成 per-tool `openInput`）③ ToolMessageCard `output_type==='audio'` 渲染 `<audio controls>` ④ AssetsDrawer audio 分支（**camelCase `outputType` 判分支——v2.4 教训落地**）⑤ App `handleRunTool(+minutes)` 与 artifact `audio` 类型映射
- **测试**：pytest **107 passed**（新增 `test_tts.py` 15 项：清洗/cap 收尾/命名确定性与内容敏感/台本解析全护栏/真实 edge-tts 双声拼接冒烟（进度+MP3 头）/路由 404·400·任务流·缓存·防穿越/podcast 帧协议 fake LLM+fake 合成含自动归档断言）；`e2e_audio.cjs` **15/15 全绿且零 LLM**——真实合成整链路（1537 字译序约 25 秒出 1.9MB mp3）、浏览器内 fetch 验 200+audio/mpeg、二次 cached、播客表单交互、资产区播放器分支、无 JS 报错
- 踩坑：① f-string 里 JSON 示例嵌套花括号写成 `}}}` 多一括号 → SyntaxError（运行时 import 第一时间拦截——铁律再次划算）；② E2E 的 `api()` helper 对 404 也 resolve 不 reject，孤章探测必须专门写 `probeStatus` 拿 statusCode；③ API 侧注入的资产 UI 不可见（favorites 是进书时拉的快照）——E2E 须 reload 触发 loadAssets；④ edge-tts 合成速度远快于实时，无需为长章设计流式边合边播；⑤ ToolDrawer 打开时顶栏钮被 z-50 面板覆盖（v2.4 同款），E2E 用背板点击关闭
- 已知边界：播客台本生成需要 DeepSeek（402 充值后跑一次真实播客 E2E 补验）；听书不支持暂停续合成（整章一体文件）；mp3 无 ID3 元数据（文件名即哈希）

## v2.4 — 2026-11-04（收藏升级"本书资产区"——后端化 + 三类资产 + 导图重放/HTML 预览 + Markdown 导出）
- **资产存储 `data/assets.json`**（`asset_store.py`）：chat/card 同款单文件 + `threading.Lock` + tmp/replace 原子写；三类 `type`：`note` 文字 / `tool` AI 产出 / `report` 报告；`output_type`：`text|html|mindmap|cards`（非法值静默降 text）；title 回落 `title→tool_name→"收藏"` 且 cap 200、content cap 30 万、正文空/未知 type/book_id 空 → `ValueError`（路由转 400）
- **4 端点**：`GET /assets?book_id&type&q`（q=标题+正文小写包含、created_at 倒序）、`POST /assets`、`DELETE /assets/{asset_id}`（404）、`GET /assets/export?book_id=&ids=`（ids 逗号分隔子集**保序**，否则按书全量；空 404；`text/markdown; charset=utf-8` + `filename*=UTF-8''`）；**路由前缀共存**：`/assets` API 先注册、dist 静态 `/assets/{filename:path}` 兜底不冲突（运行时路由枚举裁决）
- **归档语义**：删会话不级联删资产，删书才级联（`delete_assets_for_book` 挂 book_processor 卡片级联之后）
- **前端 AssetsDrawer**（替换删除的 FavoritesDrawer）：顶栏「资产」按钮带计数角标；类型 chips（`data-assets-tab`）+ 搜索 + 展开三分支——**mindmap JSON→复用 MindmapTree 树重放（点章跳原文后自动关抽屉）**、**html→`iframe sandbox=""` 沙箱预览**、text→pre-wrap；条目动作 复制/下载单条 md/hover 移除；顶栏开合钮被 z-50 面板盖住，面板内关闭钮补 `title="关闭"`（与 SessionDrawer 同款锚点）
- **收藏 API 化**（App.jsx）：`apiToFav`/`favToApi` 字段映射（`note↔'qa'` 保持旧调用点零改动）；`handleToggleFavorite` 改 POST/DELETE + 乐观更新，去重匹配用**同长 200 前缀**比对（防后端 title cap 截断错位）；工具卡收藏放开 mindmap/html 产出（携带 `outputType`）；报告卡头新增「归档报告」按钮
- **旧收藏自动迁移**：首次进书读 `reading_favorites` → `Promise.allSettled` 逐条 POST → **全部成功才 removeItem，失败条目写回等下次重试**；`favMigratedRef` 防重复触发
- **测试**：pytest **92 passed**（新增 `test_assets.py` 7 项：字段与三类 ValueError+非法 output_type 降级/筛选/删除与删书级联/导出 ids 保序/路由直调+400·404/export 响应头与正文）；`tests/e2e_assets.cjs` **21 断言全绿**且**零 LLM 设计**（注入数据全走 API：3 资产 + 假会话两条消息分别 POST `/sessions/{sid}/messages`（单消息端点）、localStorage 预置旧收藏验迁移、进书自动恢复注入会话验收藏结果/归档报告按钮、计数与 API 对账、筛选/搜索、导图重放 nodes=3、iframe srcdoc 预览、收藏+归档增删往返、移除计数 (6)→(5)、导出 MD 不含已删条目、无 JS 报错、清理 0 残留）——DeepSeek 402 欠费窗口也能跑
- 踩坑：① **AssetsDrawer 判分支用 `a.output_type`（snake），但 App 传入的是 `apiToFav` 后的 camelCase（`outputType`）——导图重放与 HTML 预览两分支从未命中**。API 层 curl 亲验数据完全正常，实锤靠浏览器级断言 `nodes=0`：**接口数据对≠前端渲染对，跨层字段命名（camel/snake 转换点）是重灾区**；② 顶栏「资产」按钮在抽屉打开后位于 z-50 面板之下，Playwright `intercepts pointer events` 拒绝点击——关抽屉必须走面板内关闭钮，补 title 锚点而非绕过测试；③ BSD grep `\|` 静默无匹配再踩一次（一律 `-E`）；④ E2E 脚本 `node --check` 先行：非 async 箭头函数里 await、CSS 选择器少 `]` 两处低级错都在跑前拦下

## v2.3 — 2026-11-04（知识卡片——抽卡入库 + Leitner 间隔复习 + 测验 + Anki 导出）
- **抽卡=第 6 个 AI 工具 `cards`**（产出即入库，无"保存"按钮）：单章一次 ≤8 张、全书 8 章/组×每组 3 张、`CARDS_TOTAL_CAP=40` 封顶；LLM 输出 `{"cards":[{front,back,cite}]}` 包裹数组（`_extract_json_obj` 只认 dict），cite 要求原文真实存在 ≤60 字；**每组 `_clean_cards(obj)[:n]` 代码侧硬截断——数量约束不能只靠 prompt 自觉**（fake 单测实证：每组返 10 张入库恰 6）；artifact `{type:"cards"}` 落会话，ToolMessageCard 渲染卡正反+引文预览（JSON 解析失败降级纯文本）
- **Leitner 五盒间隔重复**：`LEITNER_DAYS=(1,2,4,7,15)`；评分 again→盒1（明天）、good→+1 盒、easy→+2 盒（均 cap 盒5）；**新卡 `next_review`=当天**——抽完当天即进入复习队列；按日粒度排期（date 字符串比较）；到期队列排序 box 升序→next_review 升序（难卡优先）
- **存储 `data/cards.json`**：chat_store 同款单文件 + `threading.Lock` + tmp/replace 原子写；同书内 `_norm_front`（去全部空白）精确去重、跨书不去重→对同一章重复抽卡安全（重跑仅"跳过 N 张重复"）；删书级联 `delete_cards_for_book`（book_processor 中挂 chat_store 清理后）
- **6 端点**：`GET /cards?book_id=`、`GET /cards/due`、`GET /cards/stats`（`{stats:{bid:{total,due}},total,due}` 供书架徽标/抽屉计数）、`POST /cards/{id}/grade`（非法 result 400/缺失 404）、`DELETE /cards/{id}`、`GET /cards/export/anki`——三列 TSV `front\tback\ttag`，卡内换行→`<br>`、书名空格→下划线、`filename*=UTF-8''{quote(名)}`，空库 404
- **前端三入口**：① 第三路由 `#/review` 复习页（书 tabs+今日到期/随机测验切换、测验=前端 shuffle 取 10）；② 书内顶栏「卡片」满高抽屉（今日复习/随机测验/列表三态、列表 hover 删卡+盒数/复习日/归属章、Anki 下载、到期计数）；③ 书架「复习」按钮+到期徽标（99+ 截断）。共享翻卡组件 **ReviewDeck**（两入口两用，评分按钮按当前盒预算 `previewDays` 显示"N 天后"）；cardStats 由 App 统一拉取（route.view 变化+抽卡完成/评分/删卡回调刷新）；vite proxy 加 `/cards`
- **测试**：pytest 85 passed（新增 `tests/test_cards.py` 13 项：新卡当天到期/去重与跨书/Leitner 全进阶 cap5/due 难卡优先/级联/TSV 转义/路由 400·404·export/工具帧协议+重跑跳重+每组硬截断）；`tests/e2e_cards.cjs` 浏览器级 **16 断言全绿**（真实 LLM 抽卡 8 张全归所选章、复习页翻卡评分 box=2 落盘、抽屉计数=API、删卡 16→15、Anki 链接、无 JS 报错）
- 踩坑：① **Edit 顺手重打 import 块把 `fastapi` 写成非法模块名——py_compile 通过、pytest 不导入该文件也不报错，直到 venv 运行时 `ModuleNotFoundError` 才实锤**；期间一次修串的 python replace 因"错误串/正确串"生成时被转码成同一字符串而静默空转。裁决层级固化：**运行时 import > py_compile > 显示层肉眼**；② CardsDrawer 计数 span 挂载即渲染 `(0)`，E2E `waitForSelector` 只等存在不等数据，读到 0 连累 Anki 链接（`total>0` 未渲染）三断言同根 FAIL——改 `total` 初值 null 加载完才渲染 + 删卡断言短轮询等计数下降（"DOM 断言带轮询"铁律再证）；③ pytest 传不存在的路径会**静默收集 0 条只报 warning**，险成假绿；④ TocRail 条目是 onClick div 非 button，E2E 加 `data-toc` 锚点；进书默认落孤章（序言），抽卡前必须先切章否则对空内容出废卡；⑤ ToolDrawer 点工具行即运行，无"运行"按钮（首版臆造导致 CRASH）
- **回归说明**：提交当天上午 DeepSeek 账号 **402 Insufficient Balance**（探测实锤），v20/mindmap 真实 LLM 回归被阻。v20 两处 FAIL 的真根因是**进书自动恢复旧会话、工具产出落进 baseline 会话轮询永不可见**——已按 v2.1 同款教训给 v20 脚本补会话隔离步骤（+3 断言），待账号充值后全量复跑；v2.3 自身的卡片 E2E 16/16 与 pytest 85 passed 均在 LLM 可用窗口完成（卡片 E2E 本身已覆盖进书/目录/工具抽屉/落盘主链路）

## v2.2 — 2026-11-04（句内引用角标——[n] 编号 + 跳章段落高亮）
- **句内引用（排期 #30）**：RAG 问答回答句内出现 `[n]` 引用角标（编号=本轮参考段落编号），点击角标跳转原文对应章节并在**段落级**定位+琥珀色闪烁高亮 3.2s；未命中锚点优雅回落章首，重复点击同处经 nonce 重新触发
- **后端编号与锚点**：`stream_chat` 上下文块统一 `[n] ` 前缀（当前章=1，检索块顺延）；`sources` 帧每条加 `index`（int）与 `snippet`——`_source_snippet` 取块体**剥滑窗重叠前缀后**首行前 24 字（`_split_into_chunks` 按行聚合故块体起始对齐行首，前端以"段落 textContent 去空白后含 snippet"即可唯一定位）；`ChapterSearchResult` 模型补 `chunk_index`/`prefix_len` 透传锚点信息
- **引用指令注入**：`citation_instruction` 由路由器构造（仅在有来源时注入），追加到 system 末尾——**默认人格与专家 `system_prompt_override` 一路生效**；prompt 明确"编号每轮重新分配，历史回答里的旧编号不沿用"；默认格式规则与 cleanup_reminder 同步补"参考段落带编号时句末必附 [n]"
- **前端链路**：AiPanel `renderInlineCitations` 按 sources 的 index 建映射，`[n]` 渲染为 `.cite-marker` 圆形角标按钮（无编号来源时回落旧书名徽章渲染）；来源芯片加序号圆标与 `data-source-chip`；点击经 `citeJump→onNavigateToSource→App.citeTarget{chapter_id,snippet,nonce}` 透传 ReadingPane，effect 60ms 延迟等异步渲染后在 `[data-p]` 段落上 norm 比对命中→`scrollIntoView(center)`+`.cite-flash`
- **测试**：pytest 72 passed（新增 `tests/test_citations.py` 8 项：`_source_snippet` 首行/剥前缀/截断/空串、流式帧编号+锚点+指令注入、当前章=1 号 snippet 空、无来源无指令、真实 service 函数对专家 override 也追加指令）；`tests/e2e_citations.cjs` 浏览器级 **12 断言全绿**（真实 LLM：19 个角标编号全在 5 条来源范围内、跳章章名一致、高亮段落命中锚点、无 JS 报错）
- 踩坑：①给 `stream_chat` 加关键字参数后 test_chat_sessions 的 fake_stream 签名漂移炸 2 例——**加参先搜全部测试 fake/mock 同步**；②Playwright 脚本 require playwright 须走 `../frontend/node_modules/playwright` 相对路径（仓库根 node_modules 无此包）；③测试内嵌套 asyncio.run 收帧会空（须单 asyncio.run 内迭代 body_iterator）；④含 `\u` 字样的中文 docstring 必须 r-docstring 否则 unicodeescape SyntaxError

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
