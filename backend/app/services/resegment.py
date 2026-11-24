"""AI 兜底重切（二期核心）：质检判出目录残缺/单章吞书时，提取全书标题行候选
交给 LLM 重新归章。

设计铁律（防 AI 毁正文）：
1. AI 只回传"候选编号 + 标题 + 层级"，永不回传正文——章节边界由服务端
   split_by_candidates 按字符 offset 直切，正文一个字节都不经过模型。
2. 候选编号严格校验（int、全局升序、越界丢弃），AI 给的标题超长/为空时
   回退候选行原文。
3. 整批失败重试 1 次，再失败返回 None，调用方保留规则切分结果——
   重切只可能更好，不可能更坏。
"""

import json
import re
from typing import List, Optional

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from app.models.book_models import Chapter

# 每批喂给 AI 的最大候选数（内部 vLLM 上下文与输出稳定性考虑）
BATCH_SIZE = 80
# 相邻候选最小间距（更近的视为同一标题重复，保先者）
MIN_CAND_GAP = 30
# 章节最小有效长度（与 split_by_toc 口径一致）
MIN_CHAPTER_LEN = 50

# bind 时 extra_body 会整体替换构造器的值，max_tokens 与关思考必须同 dict
# （vLLM 推理模型默认开思考会吃满 max_tokens 导致 JSON 腰斩，只认嵌套 key）
RESEG_EXTRA_BODY = {
    "max_tokens": 4096,
    "chat_template_kwargs": {"enable_thinking": False},
}


class HeadingCandidate(BaseModel):
    offset: int
    text: str           # 候选行原文（标题兜底就用它）
    score: float = 0.0
    source: str = "line"  # line / regex / doc_start / number_line
    ctx: str = ""         # 该行之后一小段正文（喂 AI 判"1 后面跟着信→是信首编号"）


# 聚类互斥权重：独立编号行/文档边界是真结构信号，不被相邻普通短行挤掉
# （魔鬼家书实锤：31 个信首编号与落款行间距 <MIN_CAND_GAP，曾被落款吃掉只剩 1 个）
_SOURCE_WEIGHT = {"doc_start": 2, "number_line": 2, "regex": 1, "line": 1}


class PickedChapter(BaseModel):
    offset: int
    title: str
    level: int = 1


def extract_heading_candidates(
    full_text: str,
    *,
    doc_offsets: Optional[List[int]] = None,
    numeric_lines: bool = False,
    max_candidates: int = 600,
) -> List[HeadingCandidate]:
    """扫全文找"长得像章节标题"的行，按 offset 升序返回。

    四路来源：
    - doc_start：（EPUB）每个 spine 文档起点虚拟锚——铁证待判那种
      "原生目录残缺但 spine 本身按章切过"的书，文档边界就是真章边界
    - number_line：（仅 EPUB）独立数字行 1~31 形态——魔鬼家书每封信前
      有独立编号行。PDF 不开：页码全是独立数字行，纯噪声
    - regex：既有 _fallback_toc_detection 同款标题模式
    - line：短行 + 无句末标点 + 置信度达标的通用形态
    """
    from app.services.book_processor import BookProcessor  # 避免循环 import

    candidates: List[HeadingCandidate] = []

    def _ctx(end: int) -> str:
        """候选行之后的下文预览（AI 判边界用）"""
        tail = re.sub(r"\s+", " ", full_text[end:end + 120]).strip()
        return tail[:40]

    if doc_offsets:
        for off in doc_offsets:
            if 0 < off < len(full_text):
                candidates.append(HeadingCandidate(offset=off, text="", score=1.0,
                                                   source="doc_start", ctx=_ctx(off)))

    _end_punct = re.compile(r"[。，；：！？,.;:!?]$")
    _number_line = re.compile(r"^\d{1,3}$")
    _regex_titles = re.compile(
        r"^\s*(?:第[一二三四五六七八九十百千万零\d]+[章回节卷篇]|Chapter\s+\d+|Part\s+[\dIVXLCDM]+"
        r"|序言?|前言|引言|导论|绪论|附录|后记|跋|致谢)"
    )

    pos = 0
    for line in full_text.split("\n"):
        stripped = line.strip()
        if stripped:
            length = len(stripped)
            pure_number = bool(_number_line.match(stripped))
            is_number = numeric_lines and pure_number
            # 非 EPUB 显式排除纯数字短行：PDF 里它们绝大多数是页码
            looks_like_title = (
                (length <= 40 and not _end_punct.search(stripped) and not pure_number)
                or is_number
            )
            if looks_like_title:
                score = BookProcessor._heading_score(full_text, pos, pos + len(line), 0)
                if is_number:
                    score = max(score, 0.4)  # 独立编号行给保底分（前后隔离好，真实分常偏低）
                if _regex_titles.match(stripped):
                    score = max(score, 0.5)
                if score >= 0.35:
                    candidates.append(HeadingCandidate(
                        offset=pos, text=stripped, score=score,
                        source="number_line" if is_number else "line",
                        ctx=_ctx(pos + len(line)),
                    ))
        pos += len(line) + 1  # 补回被 split 吃掉的 \n

    # 同位置 ±MIN_CAND_GAP 聚类：来源权重优先（编号行不被相邻短行挤掉），同级保高分
    _w = _SOURCE_WEIGHT
    candidates.sort(key=lambda c: (c.offset, -_w.get(c.source, 1), -c.score))
    clustered: List[HeadingCandidate] = []
    for c in candidates:
        if clustered and c.offset - clustered[-1].offset < MIN_CAND_GAP:
            prev = clustered[-1]
            if (_w.get(c.source, 1), c.score) > (_w.get(prev.source, 1), prev.score):
                clustered[-1] = c
            continue
        clustered.append(c)

    # 上限截断：超量时按分数保优、再按 offset 还原顺序（大书防候选爆炸撑爆 prompt）
    if len(clustered) > max_candidates:
        clustered = sorted(
            sorted(clustered, key=lambda c: -c.score)[:max_candidates],
            key=lambda c: c.offset,
        )
    return clustered


def split_by_candidates(full_text: str, picked: List[PickedChapter]) -> List[Chapter]:
    """按选中候选的 offset 直切章节（纯函数，零模糊匹配）。

    首候选前若有足量内容，切成"前置内容"章；<50 字的碎段丢弃。
    chapter_id 由调用方在拿到结果后统一生成？——不，这里直接生成，
    Chapter 模型要求 chapter_id。
    """
    import uuid

    bounds = sorted({p.offset for p in picked if 0 < p.offset < len(full_text)})
    if not bounds:
        return []

    chapters: List[Chapter] = []

    def push(start: int, end: int, title: str, level: int):
        content = full_text[start:end].strip()
        if len(content) <= MIN_CHAPTER_LEN:
            return
        chapters.append(Chapter(
            chapter_id=str(uuid.uuid4()), book_id="", title=title,
            content=content, word_count=len(content),
            chapter_index=len(chapters), level=level,
            start_position=start, end_position=end,
        ))

    if bounds[0] > MIN_CHAPTER_LEN:
        push(0, bounds[0], "前置内容", 1)

    for i, off in enumerate(bounds):
        end = bounds[i + 1] if i + 1 < len(bounds) else len(full_text)
        hit = next((p for p in picked if p.offset == off), None)
        title = (hit.title if hit and hit.title else "第 %d 部分" % (i + 1)).strip()
        push(off, end, re.sub(r"\s+", " ", title)[:60], hit.level if hit else 1)

    for idx, ch in enumerate(chapters):
        ch.chapter_index = idx
    return chapters


_RESEG_SYSTEM = """你是书籍结构编辑。给出按全文顺序编号的候选标题行（含前后文），请从中挑选真正的章节起点行。

规则：
- 只输出 JSON 数组，每项 {"cand": 候选编号, "title": "不超过30字的章节标题", "level": 1或2}
- 候选编号必须严格递增（按原文顺序），不要发明没有候选的行
- 正文中引用的小标题、诗歌行、对话不是章节
- 小节（节级标题）用 level=2；大章节用 level=1
- 同一章的目录页重复行与正文标题行，只保留正文位置那条（通常在后）
- 独立编号行（如"1""2""31"）若下文直接开始正文（如信件抬头、小节正文），就是章/节起点，应选中
- 宁可少选，不可乱选；不确定的候选直接跳过"""


def _build_batch_prompt(batch: List[HeadingCandidate], start_index: int, book_title: str, context_note: str) -> str:
    lines = [f"书名：《{book_title}》{context_note}", "候选列表："]
    for i, c in enumerate(batch):
        num = start_index + i
        label = "（EPUB 文档边界）" if c.source == "doc_start" else (c.text or "")[:60]
        lines.append(f"[{num}] {label}" + (f"　下文：{c.ctx}" if c.ctx else ""))
    lines.append("请输出章节起点 JSON 数组。")
    return "\n".join(lines)


async def _ask_batch(llm, prompt: str) -> Optional[List[dict]]:
    """一批问答 + JSON 抠取，失败返回 None（调用方重试）"""
    try:
        resp = await llm.ainvoke([
            SystemMessage(content=_RESEG_SYSTEM),
            HumanMessage(content=prompt),
        ])
        raw = resp.content if hasattr(resp, "content") else str(resp)
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if not m:
            return None
        data = json.loads(m.group())
        return data if isinstance(data, list) else None
    except Exception as e:
        print(f"[重切] AI 批次失败: {e}")
        return None


async def ai_resegment(
    llm,
    full_text: str,
    candidates: List[HeadingCandidate],
    book_title: str = "",
) -> Optional[List[PickedChapter]]:
    """分批把候选喂 AI 归章，合并校验后返回章节起点；全批失败返回 None。

    返回的 title 经过合法性过滤（≤40 字，否则回退候选行原文）。
    """
    if not candidates:
        return None
    bound_llm = llm.bind(extra_body=dict(RESEG_EXTRA_BODY))

    picked: List[PickedChapter] = []
    any_success = False
    by_offset = {c.offset: c for c in candidates}

    note = f"（全书约 {len(full_text)//10000} 万字，候选分 {max(1, (len(candidates)+BATCH_SIZE-1)//BATCH_SIZE)} 批给出，本批为其中一部分）"

    for b in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[b:b + BATCH_SIZE]
        prompt = _build_batch_prompt(batch, b, book_title, note if len(candidates) > BATCH_SIZE else "")
        data = await _ask_batch(bound_llm, prompt)
        if data is None:  # 重试 1 次
            data = await _ask_batch(bound_llm, prompt)
        if data is None:
            continue
        any_success = True
        last_offset = -1
        for item in data:
            try:
                cand_no = int(item.get("cand"))
            except (TypeError, ValueError):
                continue
            if not (b <= cand_no < b + len(batch)):
                continue
            c = batch[cand_no - b]
            if c.offset <= last_offset:
                continue
            last_offset = c.offset
            title = str(item.get("title") or "").strip()
            if not title or len(title) > 40:
                title = c.text or ""
            level = 2 if item.get("level") == 2 else 1
            picked.append(PickedChapter(offset=c.offset, title=title, level=level))

    if not any_success or not picked:
        return None

    # 全局去重排序
    picked.sort(key=lambda p: p.offset)
    dedup: List[PickedChapter] = []
    for p in picked:
        if dedup and p.offset <= dedup[-1].offset:
            continue
        dedup.append(p)
    return dedup
