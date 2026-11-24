"""解析后质量检查（第一期：只记录审计，不拦截入库）。

背景：解析链路此前零质检——EPUB 原生目录残缺（铁证待判 97% 内容塞一章）、
清洗后空章（非暴力沟通索引↔chroma 不一致）、前置页混入（魔鬼家书版权页）
都静默入库。本模块把"肉眼发现"变成"机器发现"。

规则均为纯函数输入 (chapters, 统计量)，零 LLM、零 IO，逐条可单测。
阈值集中在下方常量区，调整不改逻辑。
"""

import re
from typing import List, Optional

from app.models.book_models import Chapter, QcItem, QcReport

# ── 阈值常量（质检口径唯一真源） ──────────────────────────────
SINGLE_CHAPTER_RATIO = 0.55      # R1 单章字数占比上限（且章数≤此值才判）
SINGLE_CHAPTER_MAX_COUNT = 10
SPARSE_BOOK_WORDS = 80_000       # R2 书长超此值但章数低于下限 → 切分大概率失效
SPARSE_BOOK_MIN_CHAPTERS = 8
FRONT_PAGE_MAX_WORDS = 3_000     # R3 前置页特征命中且清洗后短于此 → 建议删除
EMPTY_AFTER_CLEAN = 30           # R4 清洗后低于此字数视为空章（commit 时硬性丢弃）
CHAPTER_PAGE_MAX_WORDS = 400     # R5 清洗后短于此且非前后置内容 → 疑似纯章节页
COVERAGE_MIN = 0.55              # R7 Σ清洗后 / 提取全文 低于此 → 丢内容过多
EPUB_ANCHOR_RATIO_MIN = 0.5      # R10 原生锚点数 / spine 文档数 低于此 → 目录疑似残缺
DEGENERATE_MIN_CLEANED = 1_000   # R9 全书清洗后总字数下限

# R3 前置页标题特征
_FRONT_PAGE_TITLE = re.compile(
    r"^(版权页|书名页|封面|扉页|目录页?$|copyright|advert|epub\s*广告)", re.IGNORECASE
)
# R3 前置页内容特征（CIP/ISBN/版权声明）
_FRONT_PAGE_BODY = re.compile(
    r"(图书在版编目|CIP数据|ISBN\s*[\d\-xX]{10,}|Copyright\s*©|版权所有)", re.IGNORECASE
)
# R5 前后置内容白名单词（这些章短是正常的）
_LEGIT_SHORT = re.compile(r"(序|前言|后记|跋|致谢|导语|引言|导论|附录|译说明|出版说明|参考文献)")
# R6 章号解析：中文数字或阿拉伯数字的"第X章/回"
_CHAP_NUM = re.compile(r"第\s*([一二三四五六七八九十百\d]+)\s*[章回]")
_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
              "七": 7, "八": 8, "九": 9, "十": 10}


def _wc(ch: Chapter) -> int:
    """质检统一口径：优先清洗后长度，缺失回退清洗前（旧数据兼容）"""
    return ch.cleaned_word_count if ch.cleaned_word_count is not None else ch.word_count


def _cn_num(s: str) -> Optional[int]:
    """解析"第三章/第二十三章"里的中文数字为 int；失败返回 None"""
    if s.isdigit():
        return int(s)
    if "十" in s:
        parts = s.split("十")
        tens = _CN_DIGITS.get(parts[0], 1) if parts[0] else 1
        ones = _CN_DIGITS.get(parts[1], 0) if len(parts) > 1 and parts[1] else 0
        return tens * 10 + ones
    total = 0
    for c in s:
        if c not in _CN_DIGITS:
            return None
        total = total * 10 + _CN_DIGITS[c]
    return total


def _chap_no(title: str) -> Optional[int]:
    m = _CHAP_NUM.search(title)
    if not m:
        return None
    return _cn_num(m.group(1))


def run_quality_check(
    chapters: List[Chapter],
    *,
    full_text_chars: Optional[int] = None,
    source: str = "generic",
    epub_spine_docs: Optional[int] = None,
    epub_native_anchors: Optional[int] = None,
) -> QcReport:
    """对切分结果跑 R1~R10，返回 QcReport。

    Args:
        chapters: 切分产出的章节（cleaned_word_count 已回填则用真口径）
        full_text_chars: 提取全文字符数（R7 覆盖率分母）；None 则跳过 R7
        source: "generic"（AI/正则链路）| "epub_native"（原生目录链路）
        epub_spine_docs / epub_native_anchors: EPUB 原生链路的结构统计（R10）
    """
    items: List[QcItem] = []
    total = sum(_wc(c) for c in chapters)
    n = len(chapters)

    def add(rule: str, level: str, msg: str, cids: List[str] = None):
        items.append(QcItem(rule=rule, level=level, msg=msg, chapter_ids=cids or []))

    # R9 退化书（先判，后续规则在退化态下没有意义但仍跑，供报告完整）
    if n <= 1 or total < DEGENERATE_MIN_CLEANED:
        add("R9", "blocking", f"退化切分：{n} 章 / 清洗后共 {total} 字")

    # R1 单章占比
    for c in chapters:
        if n <= SINGLE_CHAPTER_MAX_COUNT and total > 0 and _wc(c) / total > SINGLE_CHAPTER_RATIO:
            add("R1", "warning",
                f"单章「{c.title}」占全书 {_wc(c) / total:.0%}（{_wc(c)} 字），疑似大量章节被吞",
                [c.chapter_id])

    # R2 书长章数比
    if total > SPARSE_BOOK_WORDS and n < SPARSE_BOOK_MIN_CHAPTERS:
        add("R2", "warning", f"{total} 字的书只切出 {n} 章，目录识别大概率失败")

    # R3 前置页污染（只查前 3 章：版权页几乎不可能出现在正文中部）
    for c in chapters[:3]:
        title_hit = bool(_FRONT_PAGE_TITLE.match(c.title.strip()))
        body_hit = len(c.content) <= FRONT_PAGE_MAX_WORDS * 4 and _FRONT_PAGE_BODY.search(c.content[:3000])
        if title_hit or body_hit:
            add("R3", "warning", f"「{c.title}」疑似版权页/前置页混入正文，建议删除", [c.chapter_id])

    # R4 清洗后空章
    for c in chapters:
        if c.cleaned_word_count is not None and c.cleaned_word_count < EMPTY_AFTER_CLEAN:
            add("R4", "warning",
                f"「{c.title}」清洗后仅 {c.cleaned_word_count} 字，入库时将丢弃",
                [c.chapter_id])

    # R5 纯章节页（info）
    for c in chapters:
        w = _wc(c)
        if 0 < w < CHAPTER_PAGE_MAX_WORDS and not _LEGIT_SHORT.search(c.title):
            add("R5", "info", f"「{c.title}」仅 {w} 字，疑似只有章节页", [c.chapter_id])

    # R6 层级压平（info）：无章号章被相邻两个连续章号夹住 → 疑似小节被提升为章
    for i in range(1, n - 1):
        prev_no, cur_no, next_no = _chap_no(chapters[i - 1].title), _chap_no(chapters[i].title), _chap_no(chapters[i + 1].title)
        if cur_no is None and prev_no is not None and next_no == prev_no + 1:
            add("R6", "info",
                f"「{chapters[i].title}」夹在第{prev_no}章与第{next_no}章之间，疑似小节被提升为章",
                [chapters[i].chapter_id])

    # R7 内容覆盖率（分母缺失跳过）
    if full_text_chars and full_text_chars > DEGENERATE_MIN_CLEANED:
        coverage = total / full_text_chars
        if coverage < COVERAGE_MIN:
            add("R7", "warning", f"内容覆盖率仅 {coverage:.0%}（{total}/{full_text_chars}），切分过滤器可能误杀正文")

    # R8 锚点乱序（blocking）：start_position 全有值时检查单调性
    anchors = [c.start_position for c in chapters if c.start_position is not None]
    if len(anchors) == n and n >= 2:
        inversions = [i for i in range(1, n) if anchors[i] <= anchors[i - 1]]
        if inversions:
            add("R8", "blocking",
                f"{len(inversions)} 处章节锚点乱序（目录页错锚信号），需重新切分",
                [chapters[i].chapter_id for i in inversions])

    # R10 EPUB 原生目录利用率
    if source == "epub_native" and epub_spine_docs and epub_native_anchors is not None:
        if epub_spine_docs >= 10 and epub_native_anchors < epub_spine_docs * EPUB_ANCHOR_RATIO_MIN:
            add("R10", "warning",
                f"EPUB 有 {epub_spine_docs} 个文档但原生目录仅 {epub_native_anchors} 个锚点，目录残缺、文档被整段合并")

    has_issue = any(it.level in ("warning", "blocking") for it in items)
    return QcReport(auto_commit=not has_issue, items=items)
