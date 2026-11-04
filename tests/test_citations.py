r"""句内引用（v2.2）：[n] 编号上下文、来源 anchor snippet、引用规则注入 测试

CJK 断言一律用 \u 码点构造（显示层变形教训）。绕开 TestClient：直调端点函数迭代 body_iterator。
"""

import sys
import json
import asyncio
from pathlib import Path

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.models.book_models import ChapterSearchResult

pytest_plugins = ("pytest_asyncio",)

# 关键 CJK 片段（码点构造）
KW_NUM_RULE = "\u5f15\u7528\u7f16\u53f7\u89c4\u5219"          # 引用编号规则
KW_CUR_CHAPTER = "\u5f53\u524d\u7ae0\u8282"                     # 当前章节
KW_OLD_NUM = "\u65e7\u7f16\u53f7"                               # 旧编号


class FakeChapter:
    def __init__(self, cid, title, content=None, book_id="bk1"):
        self.chapter_id = cid
        self.title = title
        self.content = content if content is not None else "\u6b63\u6587\u3002" * 50  # 正文。
        self.chapter_index = 0
        self.word_count = 100
        self.book_id = book_id


def make_result(cid, chunk_text, chapter_index=3, chunk_index=1, prefix_len=0, title=None):
    return ChapterSearchResult(
        chapter_id=cid,
        book_id="bk1",
        book_title="\u300a\u4e66\u300b",  # 《书》
        title=title or ("\u7b2c\u4e09\u7ae0" * 1),  # 第三章
        content_snippet=chunk_text,
        chapter_index=chapter_index,
        relevance_score=0.7,
        chunk_index=chunk_index,
        prefix_len=prefix_len,
    )


def collect_frames(agen):
    async def run():
        out = []
        async for frame in agen:
            out.append(frame)
        return out

    raw = asyncio.run(run())
    parsed = []
    for f in raw:
        payload = f[len("data: "):].strip()
        parsed.append(payload if payload == "[DONE]" else json.loads(payload))
    return parsed


# ---------------------------------------------------------------- 锚点函数


class TestSourceSnippet:
    def test_first_line_prefix(self):
        from app.routers.analysis import _source_snippet
        text = "\u8fd9\u662f\u9996\u884c\u5185\u5bb9\n\u7b2c\u4e8c\u884c"  # 这是首行内容\n第二行
        assert _source_snippet(text) == "\u8fd9\u662f\u9996\u884c\u5185\u5bb9"

    def test_strips_overlap_prefix(self):
        from app.routers.analysis import _source_snippet
        overlap = "\u4e0a\u4e00\u5757\u7684\u5c3e\u5df4"  # 上一块的尾巴
        body = "\u771f\u6b63\u7684\u9996\u884c"           # 真正的首行
        text = overlap + "\n" + body
        assert _source_snippet(text, prefix_len=len(overlap)) == body

    def test_truncates_24_chars(self):
        from app.routers.analysis import _source_snippet
        line = "\u554a" * 60  # 啊*60
        assert len(_source_snippet(line)) == 24

    def test_empty_returns_empty(self):
        from app.routers.analysis import _source_snippet
        assert _source_snippet("") == ""
        assert _source_snippet("\n\u540e\u9762\u6709\u5185\u5bb9") == ""  # 后面有内容


# ---------------------------------------------------------------- 端点装配


def drive(monkeypatch, request, search_results, chapter=None):
    """直调 /analysis/chat/stream 端点：桩掉检索与 LLM，返回 (帧列表, 传给 stream_chat 的 kwargs)"""
    import app.routers.analysis as m

    captured = {}

    async def fake_search(query=None, book_ids=None, n_results=5):
        return search_results

    monkeypatch.setattr(m.book_processor, "search_chapters", fake_search)
    monkeypatch.setattr(m.book_processor, "get_chapter_by_id", lambda cid: chapter)

    def fake_stream(message=None, chapter_context=None, chat_history=None,
                    system_prompt_override=None, citation_instruction=None):
        captured["chapter_context"] = chapter_context
        captured["citation_instruction"] = citation_instruction
        async def gen():
            yield "\u56de\u7b54[\u5360\u4f4d]"  # 回答[占位]
        return gen()

    monkeypatch.setattr(m.analysis_service, "stream_chat", fake_stream)

    async def run():
        resp = await m.stream_chat(request)
        out = []
        async for frame in resp.body_iterator:
            out.append(frame)
        return out

    raw = asyncio.run(run())
    frames = []
    for f in raw:
        payload = f[len("data: "):].strip()
        frames.append(payload if payload == "[DONE]" else json.loads(payload))
    return frames, captured


class TestStreamCitationWiring:
    def test_chunks_numbered_and_anchored(self, monkeypatch):
        import app.routers.analysis as m
        req = m.ChatRequest(message="Q", book_id="bk1")
        r1 = make_result("c1", "\u951a\u70b9\u4e00\n\u5185\u5bb9A\n\u5185\u5bb9B")  # 锚点一/内容A/内容B
        r2 = make_result("c2", "\u91cd\u53e0\u524d\u7f00\n\u951a\u70b9\u4e8c", prefix_len=4)  # 重叠前缀/锚点二
        frames, cap = drive(monkeypatch, req, [r1, r2])

        ctx = cap["chapter_context"]
        assert ctx.startswith("[1] ")
        assert "[2] " in ctx
        # snippet：剥重叠前缀后的首行前缀
        srcs = [f["sources"] for f in frames if isinstance(f, dict) and "sources" in f][0]
        assert [s["index"] for s in srcs] == [1, 2]
        assert srcs[0]["snippet"] == "\u951a\u70b9\u4e00"  # 锚点一
        assert srcs[1]["snippet"] == "\u951a\u70b9\u4e8c"  # 锚点二
        # 引用规则注入
        instr = cap["citation_instruction"]
        assert instr and KW_NUM_RULE in instr
        # 规则里给出的示例编号是 ASCII
        assert "[2][3]" in instr

    def test_current_chapter_numbered_first(self, monkeypatch):
        import app.routers.analysis as m
        req = m.ChatRequest(message="Q", book_id="bk1", chapter_id="c0")
        chapter = FakeChapter("c0", "\u5f15\u5e8f")  # 序引 → 引序
        r1 = make_result("c1", "\u5757\u9996\u884c")  # 块首行
        frames, cap = drive(monkeypatch, req, [r1], chapter=chapter)

        ctx = cap["chapter_context"]
        assert ctx.startswith("[1] [" + KW_CUR_CHAPTER + "\uff1a\u5f15\u5e8f]")
        srcs = [f["sources"] for f in frames if isinstance(f, dict) and "sources" in f][0]
        assert srcs[0]["index"] == 1 and srcs[0]["snippet"] == ""
        assert srcs[0]["chapter_title"] == "\u5f15\u5e8f"
        assert srcs[1]["index"] == 2

    def test_no_sources_no_instruction(self, monkeypatch):
        import app.routers.analysis as m
        req = m.ChatRequest(message="Q")
        frames, cap = drive(monkeypatch, req, [])
        assert cap["chapter_context"] is None
        assert cap["citation_instruction"] is None
        assert not any(isinstance(f, dict) and "sources" in f for f in frames)

    def test_service_appends_instruction_to_system(self, monkeypatch):
        """analysis_service 真实函数：citation_instruction 追加进 system，专家换轨同样生效"""
        import app.services.analysis_service as svc
        captured = {}

        class FakeLLM:
            async def astream(self, messages):
                captured["messages"] = messages
                class C:
                    content = ""
                yield C()

        service = svc.analysis_service
        monkeypatch.setattr(type(service), "streaming_llm", property(lambda self: FakeLLM()))

        async def run():
            out = []
            async for c in service.stream_chat(
                message="Q",
                chapter_context="[1] \u53c2\u8003",  # 参考
                system_prompt_override="EXPERT_PERSONA",
                citation_instruction="\u3010CITE_RULE\u3011",
            ):
                out.append(c)
            return out

        asyncio.run(run())
        sysmsg = captured["messages"][0].content
        assert sysmsg.startswith("EXPERT_PERSONA")
        assert "\u3010CITE_RULE\u3011" in sysmsg
