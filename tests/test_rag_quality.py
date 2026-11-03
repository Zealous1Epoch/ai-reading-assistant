"""
RAG 质量回归测试：滑窗切块单元测试 + 真实馆藏黄金问题集。

黄金问题集依赖本机 backend/data 里已重建的 book_chapters_v2（跑过
scripts/rebuild_vectors.py 或重新上传解析过馆藏）。馆藏不足时自动 skip，
不影响无数据的 CI 环境。

运行：PYTHONPATH=backend pytest tests/ -v
"""

import json
import sys
from pathlib import Path

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.config import get_settings
from app.services.book_processor import BookProcessor

settings = get_settings()


# ── 滑窗切块单元测试（不依赖模型与真实馆藏）────────────────────

class TestChunkSplitting:
    @pytest.fixture
    def processor(self, tmp_path):
        return BookProcessor(persist_directory=str(tmp_path / "chroma_chunk"))

    def test_short_text_single_chunk(self, processor):
        """短于 target 的章节不切块、无重叠前缀"""
        text = "很短的一段章节内容，只有一小块。"
        chunks = processor._split_into_chunks(text, target=650, overlap=130)
        assert chunks == [(text, 0)]

    def test_empty_text(self, processor):
        assert processor._split_into_chunks("") == []

    def test_chunk_size_bounded(self, processor):
        """块长受 target + overlap 约束，不会失控"""
        text = "\n".join(f"这是第{i}行正文，用来凑出一本假书所需的长度以便触发切块。" for i in range(300))
        chunks = processor._split_into_chunks(text, target=650, overlap=130)
        assert len(chunks) > 5
        for content, _ in chunks:
            assert len(content) <= 650 + 130 + 1

    def test_overlap_prefix_consistent(self, processor):
        """第 i 块的前 prefix_len 字必须等于第 i-1 块的尾部——重叠真实存在"""
        text = "\n".join(f"编号{i}的句子，防止关键论证恰好跨块被切断所以要留重叠缓冲。" for i in range(200))
        chunks = processor._split_into_chunks(text, target=300, overlap=60)
        assert len(chunks) > 2
        for i in range(1, len(chunks)):
            prev, (_, prefix_len) = chunks[i - 1][0], chunks[i]
            assert prefix_len > 0
            assert chunks[i][0][:prefix_len] == prev[-prefix_len:]

    def test_assemble_strips_overlap_no_duplication(self, processor):
        """拼回整章后每行恰好出现一次——阅读视图无重复文字"""
        text = "\n".join(f"独一无二的句子序号{i}。" for i in range(200))
        chunks = processor._split_into_chunks(text, target=300, overlap=60)
        assembled = processor._assemble_chunks(chunks)
        for i in range(200):
            assert assembled.count(f"独一无二的句子序号{i}。") == 1

    def test_overlong_paragraph_hard_split_reassembles(self, processor):
        """单段超长（无换行）也能切并完整拼回"""
        text = "甲" * 1000
        chunks = processor._split_into_chunks(text, target=300, overlap=50)
        assert len(chunks) >= 4
        assembled = processor._assemble_chunks(chunks)
        assert assembled.count("甲") == 1000


# ── 真实馆藏黄金问题集 ────────────────────────────────────────

def _load_index():
    p = Path(settings.data_dir) / "books_index.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


_INDEX = _load_index()
_TITLES = {e.get("title"): bid for bid, e in _INDEX.items()}

GOLDEN_QUERIES = [
    # (问题, 书名, 期望出现在 top-3 任一结果的 章节标题关键词 或 块内容关键词)
    ("非暴力沟通的四个要素是什么", "非暴力沟通", ["四", "观察", "感受"]),
    ("观察和评论怎么区分", "非暴力沟通", ["观察"]),
    ("如何表达愤怒才不至于伤人", "非暴力沟通", ["愤怒"]),
    ("怎样提出请求对方才愿意答应", "非暴力沟通", ["请求"]),
    ("耶稣复活有哪些历史证据", "铁证待判", ["复活"]),
    ("耶稣的家谱记载在哪里", "铁证待判", ["家谱"]),
    ("路加福音的作者是谁", "铁证待判", ["路加"]),
    ("神存在的证据是什么", "游子吟", ["神存在"]),
    ("圣经的预言应验了吗", "游子吟", ["预言"]),
    ("人类道德律说明了什么", "游子吟", ["道德"]),
]


def _available_queries():
    """只保留馆藏里实际有书、且有向量的用例"""
    usable = []
    for q, book, keys in GOLDEN_QUERIES:
        if book in _TITLES:
            usable.append(pytest.param(q, _TITLES[book], book, keys, id=f"{book}-{q[:12]}"))
    return usable


@pytest.mark.asyncio(loop_scope="function")
@pytest.mark.skipif(not _available_queries(), reason="本机馆藏无向量，跳过黄金问题集")
@pytest.mark.parametrize("q,bid,book,keys", _available_queries() or [pytest.param("", "", "", [], id="placeholder", marks=pytest.mark.skip)])
async def test_golden_query_top3_hit(q, bid, book, keys):
    """每个黄金问题的 top-3 命中中，至少一条的章节标题或块内容含期望关键词"""
    from app.services.book_processor import book_processor

    results = await book_processor.search_chapters(q, book_ids=[bid], n_results=3)
    hit = any(
        any(k in r.title or k in r.content_snippet for k in keys)
        for r in results
    )
    top = [(r.title, round(r.relevance_score, 3)) for r in results]
    assert hit, f"{book}《{q}》 top-3 未命中期望关键词 {keys}；实际={top}"


@pytest.mark.asyncio(loop_scope="session")
@pytest.mark.skipif("非暴力沟通" not in _TITLES, reason="馆藏缺书")
async def test_irrelevant_query_returns_few_or_low_scores():
    """与书完全无关的查询：要么被阈值全挡，要么高分结果不存在"""
    from app.services.book_processor import book_processor

    results = await book_processor.search_chapters(
        "量子色动力学夸克禁闭", book_ids=[_TITLES["非暴力沟通"]], n_results=5
    )
    for r in results:
        assert r.relevance_score < 0.60, f"无关查询打出了过高分：{r.title} {r.relevance_score}"
