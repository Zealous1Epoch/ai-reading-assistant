"""逐题引导会话路由（v3.4）——「读书十问」「导读」一题一停

与旧 /api/tools/{questions,summarize} 一次性产出的区别：
- 题单只生成一次（结构化 JSON、指路章名回查真实章目录防幻觉），进度存 guide_store；
- 每步只做一次原子 LLM 调用：讲评追问 / 本题小结 / 收束清单；
- 「下一题」是纯状态推进，由 can_advance 硬门禁把关——strict（十问）必须先出小结，
  soft（导读）答过一轮即可。核心概述压到全部答完才揭示（overview_revealed 落库）。

SSE 帧协议与 tools.py 同款：status / content / artifact / error / [DONE]。
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel
from typing import List, Optional

from app.services.book_processor import book_processor
from app.services import guide_store
from app.routers.tools import (
    _frame, DONE_FRAME, _context, _book_title, _llm_json,
    _norm_title, CHAPTER_CAP, MAP_CHUNK, MAP_GROUP_SIZE,
)

router = APIRouter(prefix="/guides", tags=["逐题引导"])

REPLY_CONTEXT_CAP = 12000      # 讲评/小结时给模型的原文预算（不必全书 30k）
TRANSCRIPT_CAP = 6000


class GuideStartRequest(BaseModel):
    book_id: str
    chapter_id: Optional[str] = None


class ReplyRequest(BaseModel):
    q_index: int
    text: str


class QIndexRequest(BaseModel):
    q_index: int


def _scope_chapters(book_id: str, chapter_id: Optional[str]):
    chapters = book_processor.get_full_chapters(book_id)
    if not chapters:
        raise HTTPException(status_code=404, detail="找不到书籍或章节内容")
    if chapter_id:
        for ch in chapters:
            if ch.chapter_id == chapter_id:
                return [ch], ch.title
    return chapters, "整本书"


def _public(g: dict) -> dict:
    """未揭示前核心概述不出接口——防前端拿到整包 JSON 剧透"""
    out = dict(g)
    if not g.get("overview_revealed"):
        out["overview"] = ""
    return out


def _guide_context(chapters) -> str:
    if len(chapters) == 1:
        ch = chapters[0]
        return f"[{ch.title}]\n{ch.content[:REPLY_CONTEXT_CAP]}"
    return _context(chapters, budget=REPLY_CONTEXT_CAP)


def _transcript(guide: dict, q_index: int) -> str:
    turns = (guide.get("per_q") or [])[q_index].get("turns") or []
    text = "\n".join(("读者：" if t["role"] == "reader" else "教练：") + t["text"] for t in turns)
    return text[-TRANSCRIPT_CAP:]


def _sanitize_questions(raw_list, valid_titles: set) -> List[dict]:
    """模型回的题单收口：丢空题面；指路章名归一化匹配真实章目录（幻觉章置空）"""
    norm_map = {_norm_title(t): t for t in valid_titles}
    out = []
    for it in raw_list or []:
        q = str((it or {}).get("q", "")).strip()
        if not q:
            continue
        pointer = str((it or {}).get("pointer", "")).strip()
        out.append({"q": q, "pointer": norm_map.get(_norm_title(pointer), "")})
    return out


# ---------------------------------------------------------------- 题单生成提示词

def _questions_prompt(chapters, scope_desc: str, book: str) -> str:
    toc = "\n".join("- " + ch.title for ch in chapters[:80])
    return f"""你不是来回答问题的——你要出一张考卷，之后逐题发给还没读透这本书的读者。本次范围：{scope_desc}。

出题立意（共十题，顺序保留，逐条改造成考题）：
1 作者想解决的核心问题；2 前人研究/回答到了什么程度；3 作者的独特新答案或新视角；4 支撑论点的新素材与案例；5 同主题他书与本书的分歧；6 本书结论的局限或被质疑处；7 作者留下的未决问题与新方向；8 给外行的跨界启发；9 全书最有启发的案例或故事；10 最值得落实的一个行动建议。

出题规则：
1. 立意句只是题源，禁止照抄——每题措辞必须挂上本书的具体人物、核心概念、章节标题或案例，让题面只可能属于这本书。
2. pointer 填读者该去翻哪一章（只指路，不给答案或结论暗示），必须逐字使用下面章目录里的章名；确无对应材料就留空串。
3. 单章范围时，十题围绕这一章展开，pointer 全部留空串。

章目录（《{book}》）：
{toc}

书籍内容：
{_context(chapters)}

只输出 JSON（不要解释、不要代码围栏）：
{{"questions": [{{"q": "题面（60字内）", "pointer": "真实章名或空串"}}]}}
questions 数组必须恰好 10 项。"""


def _lead_single_prompt(ch) -> str:
    return f"""下面这一章（《{ch.title}》）读者还没读。产出一份"一题一题过"的导读单。

要求：
- pre：4-6 个预读问题，按阅读推进顺序排（开头抛出的问题放第一个）。每题必须挂本章具体的人物/概念/案例改写，读者得去原文里找才算答得上来；pointer 能定位到小节就写小节题或章名，定位不了留空串。"作者想说什么"这类通用空问不要。
- check：3-5 条读后自查项，合上书可自验的说法（"能否用自己的话讲清……""能否举出……"），只列检查项，不写答案。
- overview：核心概述（300字内，含关键论点与结论）。它是给读完的人对答案用的，读者没走完导读题之前不会看到。

《{ch.title}》原文：
{ch.content[:CHAPTER_CAP]}

只输出 JSON（不要解释、不要代码围栏）：
{{"pre": [{{"q": "预读问题", "pointer": "节/章名或空串"}}], "check": ["自查项"]], "overview": "核心概述"}}"""


def _lead_book_reduce_prompt(partials_text: str, book: str, n_ch: int, toc: str) -> str:
    return f"""以下是《{book}》全书分段提炼的要点（覆盖全部 {n_ch} 节）：

{partials_text[:24000]}

产出一份"一题一题过"的全书导读单：
- pre：4-6 个全书级预读导问，按全书脉络排序，每题带具体概念/案例名（通用空问不要）；pointer 必须逐字用下面章目录里的章名。
- check：3-5 条通读自查项（"能否不翻书讲出……""能否说出第×章那个例子的来龙去脉"），只列检查项不写答案。
- overview：全书核心概述（400字内）。读者没走完导问之前不会看到它。

章目录：
{toc}

只输出 JSON（不要解释、不要代码围栏）：
{{"pre": [{{"q": "导问", "pointer": "真实章名或空串"}}], "check": ["自查项"]], "overview": "核心概述"}}"""


def _reply_prompt(guide: dict, chapters, book: str, q_index: int, latest: str) -> str:
    q = guide["questions"][q_index]
    ptr = f"\n指路：{q['pointer']}" if q.get("pointer") else ""
    convo = _transcript(guide, q_index)
    return f"""你是读书教练，正与读者逐题研读《{book}》（共 {len(guide['questions'])} 题，现在第 {q_index + 1} 题，只讨论这一题）。

本题：{q['q']}{ptr}

原文参考：
{_guide_context(chapters)}

本题对话记录：
{convo}

读者刚说：{latest}

请针对读者这句话讲评：
1. 先用一句话点出他哪里想对了、哪里还偏着（别奉承，偏了就说偏了）；
2. 依据原文只补最关键的一处缺口或一个反例，点到为止——完整小结是下一轮的事，这条回复里不许把本题答案整个给完；
3. 结尾抛一个更聚焦的追问，把读者往作者原意再逼一步（只问一个）。
纯文本，不用 Markdown，150字内。"""


def _summary_prompt(guide: dict, chapters, book: str, q_index: int) -> str:
    q = guide["questions"][q_index]
    return f"""你是读书教练。读者刚完成《{book}》第 {q_index + 1}/{len(guide['questions'])} 题的研读。

本题：{q['q']}

原文参考：
{_guide_context(chapters)}

本题对话记录：
{_transcript(guide, q_index)}

请写 2-3 行本题小结：
1. 这一题作者的准确原意是什么（点明「《书名》·章节名」出处）；
2. 读者一开始答到哪、后来想通了什么、还剩哪一点没啃动（没有就说没有，不编）。
诚实收束，不美化读者表现。纯文本，不用 Markdown，140字内。"""


def _closing_prompt(guide: dict, book: str) -> str:
    blocks = []
    for i, q in enumerate(guide["questions"]):
        per = guide["per_q"][i]
        convo = "\n".join(("读者：" if t["role"] == "reader" else "教练：") + t["text"]
                          for t in per.get("turns", []))[-1200:]
        blocks.append(f"第{i + 1}题：{q['q']}\n对话：{convo or '（读者未作答）'}\n小结：{per.get('summary') or '（未出小结）'}")
    transcript = "\n\n".join(blocks)[:16000]
    return f"""你是读书教练。这是你与读者围绕《{book}》逐题走完的一整场考（{len(guide['questions'])} 题全程记录）。

{transcript}

请基于全程写收束清单：
1. 真正想通了什么：读者自己说通的论点（简短列举，没有就直说没有）；
2. 没啃动的：逐条列出含糊、答偏或跳过的题号与卡壳表现（一两句），附建议重读位置；
3. 一句话总结这个读者暴露的阅读习惯盲区。
诚实，不美化。纯文本，不用 Markdown，400字内。"""


def _stream_and_append(prompt: str, guide_id: str, q_index: Optional[int], as_role: str, on_done=None):
    """通用：流式推送一次补全；结束后整段写入该题 turns（或走 on_done 落库回调）"""
    from app.services.analysis_service import analysis_service

    async def gen():
        acc = []
        try:
            async for msg in analysis_service.llm.astream([HumanMessage(content=prompt)]):
                piece = msg.content if isinstance(msg.content, str) else ""
                if piece:
                    acc.append(piece)
                    yield _frame({"content": piece})
        except Exception as e:
            yield _frame({"error": f"生成失败：{e}"})
            yield DONE_FRAME
            return
        text = "".join(acc).strip()
        if text:
            if on_done:
                on_done(guide_id, text)
            elif q_index is not None:
                guide_store.append_turn(guide_id, q_index, as_role, text)
        yield DONE_FRAME
    return gen()


# ---------------------------------------------------------------- 端点

@router.post("/questions/start")
async def start_questions(request: GuideStartRequest):
    """生成十问考卷并开一场逐题会话（SSE：status…artifact=guide）"""
    chapters, scope_desc = _scope_chapters(request.book_id, request.chapter_id)
    book = _book_title(request.book_id)
    valid_titles = {ch.title for ch in chapters}

    async def gen():
        yield _frame({"status": "出题中：逐题改造只属于这本书的考卷…"})
        obj = await _llm_json(_questions_prompt(chapters, scope_desc, book))
        questions = _sanitize_questions((obj or {}).get("questions"), valid_titles)
        if len(questions) < 8:
            yield _frame({"error": "考卷生成失败（题数不足），请重试"})
            yield DONE_FRAME
            return
        guide = guide_store.create_guide(
            request.book_id, "questions", f"读书十问 · {book}",
            questions[:10], scope_label=scope_desc, chapter_id=request.chapter_id)
        yield _frame({"artifact": {"type": "guide", "data": _public(guide)}})
        yield DONE_FRAME
    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/lead/start")
async def start_lead(request: GuideStartRequest):
    """生成导读单（预读题+自查清单+概述）并开逐题会话；单章一次成，全书 map-reduce"""
    chapters, scope_desc = _scope_chapters(request.book_id, request.chapter_id)
    book = _book_title(request.book_id)
    valid_titles = {ch.title for ch in chapters}

    async def gen():
        if len(chapters) == 1:
            yield _frame({"status": "导读单生成中…"})
            obj = await _llm_json(_lead_single_prompt(chapters[0]))
        else:
            groups = [chapters[i:i + MAP_GROUP_SIZE] for i in range(0, len(chapters), MAP_GROUP_SIZE)]
            partials = []
            for i, grp in enumerate(groups, 1):
                yield _frame({"status": f"通读全书 {i}/{len(groups)} 段"})
                part_prompt = f"""以下是《{book}》一书的一部分（第 {grp[0].title} 至 {grp[-1].title}，共 {len(grp)} 节），请提炼这部分的主要内容。
每节给出 1-3 行要点，保留关键论据、案例和数据细节。纯文本输出，不要客套话。

{_context(grp, budget=MAP_CHUNK)}"""
                from app.services.analysis_service import analysis_service
                resp = await analysis_service.llm.ainvoke([HumanMessage(content=part_prompt)])
                partials.append(f"【{grp[0].title} — {grp[-1].title}】\n{resp.content}")
            yield _frame({"status": "汇总导读单…"})
            toc = "\n".join("- " + ch.title for ch in chapters[:80])
            obj = await _llm_json(_lead_book_reduce_prompt("\n\n".join(partials), book, len(chapters), toc))

        pre = _sanitize_questions((obj or {}).get("pre"), valid_titles)
        check = [str(c).strip()[:200] for c in ((obj or {}).get("check") or []) if str(c).strip()][:6]
        overview = str((obj or {}).get("overview") or "").strip()
        if len(pre) < 3 or not overview:
            yield _frame({"error": "导读单生成失败，请重试"})
            yield DONE_FRAME
            return
        guide = guide_store.create_guide(
            request.book_id, "lead", f"导读 · {scope_desc}",
            pre, scope_label=scope_desc, chapter_id=request.chapter_id, overview=overview)
        guide_store.set_checklist(guide["guide_id"], check)
        yield _frame({"artifact": {"type": "guide", "data": _public(guide_store.get_guide(guide["guide_id"]))}})
        yield DONE_FRAME
    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("")
async def list_guides(book_id: Optional[str] = None, status: Optional[str] = None):
    out = [ _public(g) for g in guide_store.list_guides(book_id)]
    if status:
        out = [g for g in out if g.get("status") == status]
    return {"guides": out}


@router.get("/{guide_id}")
async def get_guide(guide_id: str):
    g = guide_store.get_guide(guide_id)
    if not g:
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    return {"guide": _public(g)}


@router.post("/{guide_id}/reply")
async def reply(guide_id: str, request: ReplyRequest):
    """读者作答 → AI 讲评+追问（流式；只针对当前题，不推进）"""
    g = guide_store.get_guide(guide_id)
    if not g:
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    if request.q_index != g.get("current_index"):
        raise HTTPException(status_code=409, detail="只能回答当前题")
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="回答为空")
    chapters, _ = _scope_chapters(g["book_id"], g.get("chapter_id"))
    book = _book_title(g["book_id"])
    guide_store.append_turn(guide_id, request.q_index, "reader", request.text)
    prompt = _reply_prompt(guide_store.get_guide(guide_id), chapters, book, request.q_index, request.text.strip())
    return StreamingResponse(
        _stream_and_append(prompt, guide_id, request.q_index, "coach"),
        media_type="text/event-stream")


@router.post("/{guide_id}/summarize")
async def summarize(guide_id: str, request: QIndexRequest):
    """本题小结（strict 模式放行下一题的凭证）"""
    g = guide_store.get_guide(guide_id)
    if not g:
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    if request.q_index != g.get("current_index"):
        raise HTTPException(status_code=409, detail="只能小结当前题")
    per = g["per_q"][request.q_index]
    if not any(t.get("role") == "reader" for t in per.get("turns", [])):
        raise HTTPException(status_code=409, detail="先作答，才能出小结")
    chapters, _ = _scope_chapters(g["book_id"], g.get("chapter_id"))
    book = _book_title(g["book_id"])
    prompt = _summary_prompt(g, chapters, book, request.q_index)
    return StreamingResponse(
        _stream_and_append(prompt, guide_id, None, "",
                           on_done=lambda gid, text: guide_store.set_summary(gid, request.q_index, text)),
        media_type="text/event-stream")


@router.post("/{guide_id}/advance")
async def advance(guide_id: str):
    """下一题：纯状态推进，硬门禁在 can_advance——不满足 409，绝无模型自行跳题的可能"""
    g = guide_store.get_guide(guide_id)
    if not g:
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    idx = g.get("current_index", 0)
    if idx >= len(g.get("questions") or []):
        raise HTTPException(status_code=409, detail="已全部走完")
    if not guide_store.can_advance(g, idx):
        if g.get("strict"):
            raise HTTPException(status_code=409, detail="本题还没出小结——先作答并点「小结本题」")
        raise HTTPException(status_code=409, detail="本题还没作答")
    return {"guide": _public(guide_store.advance(guide_id))}


@router.post("/{guide_id}/overview")
async def reveal(guide_id: str):
    """核心概述：全部答完才揭示"""
    g = guide_store.get_guide(guide_id)
    if not g:
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    if g.get("status") != "done" and not g.get("overview_revealed"):
        raise HTTPException(status_code=409, detail="走完全部题目才揭示核心概述")
    return {"overview": g.get("overview", ""), "guide": _public(guide_store.reveal_overview(guide_id))}


@router.post("/{guide_id}/closing")
async def closing(guide_id: str):
    """收束清单：整场问答跑完后的诚实总结（流式）"""
    g = guide_store.get_guide(guide_id)
    if not g:
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    if g.get("status") != "done":
        raise HTTPException(status_code=409, detail="还没走完全部题目")
    book = _book_title(g["book_id"])
    return StreamingResponse(
        _stream_and_append(_closing_prompt(g, book), guide_id, None, "",
                           on_done=lambda gid, text: guide_store.set_closing(gid, text)),
        media_type="text/event-stream")


@router.delete("/{guide_id}")
async def delete_guide(guide_id: str):
    if not guide_store.delete_guide(guide_id):
        raise HTTPException(status_code=404, detail="找不到该引导会话")
    return {"ok": True}
