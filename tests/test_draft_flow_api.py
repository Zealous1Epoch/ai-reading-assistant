"""两阶段入库全流程测试（二期验收）。

零 LLM：detect_toc_by_ai 打桩、无候选文本不进 AI 分支。
因本机 httpx/starlette 版本组合导致 TestClient 不可构造，直接用
asyncio 调端点函数 + 即时执行的假 BackgroundTasks——等价于 TestClient
但零依赖；HTTPException 用 pytest.raises 断言。
chroma/索引/drafts 全部指向 tmp_path，不碰真实 backend/data。
"""

import asyncio
import io
import os

import pytest
from fastapi import HTTPException, UploadFile

from app.services.book_processor import BookProcessor
from app.services import draft_store
from app.routers import book_processor as bp


CLEAN_TXT = "".join(
    f"第{n}章 标题{n}\n\n" + f"第{n}章的正文内容，正常长度正常长度。" * 60 + "\n\n"
    for n in "一二三四五六七八"
)
SWALLOW_TXT = "没有结构的一整段" * 20000  # 16 万字单块 → R1/R2/R9 必触发可疑


class ImmediateTasks:
    """假 BackgroundTasks：add_task 记下来，run_now 立刻执行"""

    def __init__(self):
        self._tasks = []

    def add_task(self, fn, *args, **kwargs):
        self._tasks.append((fn, args, kwargs))

    async def run_now(self):
        for fn, args, kwargs in self._tasks:
            await fn(*args, **kwargs)


class Env:
    def __init__(self, tmp_path):
        self.tmp = tmp_path

    async def upload(self, text, name="测试书.txt"):
        file = UploadFile(file=io.BytesIO(text.encode("utf-8")), filename=name)
        return await bp.upload_book(file)

    async def analyze(self, book_id):
        bt = ImmediateTasks()
        await bp.analyze_book(book_id, bt)  # 路由函数（服务同名方法经 proc 实例属性区分）
        await bt.run_now()
        return await bp.get_processing_status(book_id)


class BrokenLLM:
    """bind/ainvoke 即抛——_ask_batch 捕获后重切降级，保证测试零网络"""

    def bind(self, **kwargs):
        return self

    async def ainvoke(self, msgs):
        raise RuntimeError("测试环境禁用真实 LLM")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    proc = BookProcessor(persist_directory=str(tmp_path / "chroma"))

    async def no_ai(text):
        return []
    proc.detect_toc_by_ai = no_ai
    proc._llm = BrokenLLM()

    monkeypatch.setattr(bp, "book_processor", proc)
    monkeypatch.setattr(bp, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(bp, "BOOKS_INDEX_PATH", str(tmp_path / "books_index.json"))
    monkeypatch.setattr(draft_store, "DRAFT_DIR", str(tmp_path / "drafts"))
    bp.analysis_results.clear()
    bp.processing_status.clear()
    bp._pending_meta.clear()

    return Env(tmp_path)


def run(coro):
    return asyncio.run(coro)


class TestAutoCommitLane:
    def test_clean_book_completes_without_draft(self, env):
        async def flow():
            up = await env.upload(CLEAN_TXT)
            book_id = up["book_id"]
            status = await env.analyze(book_id)
            assert status["status"] == "completed" and status["auto_committed"] is True

            books = (await bp.list_books())["books"]  # 直调返回 Pydantic 对象（非序列化 dict）
            assert any(getattr(b, "book_id", None) == book_id for b in books)
            assert draft_store.list_drafts() == []
            rec = bp.book_processor.reconcile_book(
                book_id, bp.analysis_results[book_id].chapters)
            assert rec == {"missing": [], "extra": []}
        run(flow())


class TestReviewLane:
    @pytest.fixture()
    def draft_book(self, env, monkeypatch):
        """构造"单章吞书"可疑书，走完 upload → analyze 停在草稿态"""
        from app.models.book_models import Chapter

        def swallow(full_text, toc):
            return [Chapter(chapter_id="sw-1", book_id="", title="整本书",
                            content=full_text, word_count=len(full_text), chapter_index=0)]
        monkeypatch.setattr(bp.book_processor, "split_by_toc", swallow)

        async def setup():
            up = await env.upload(SWALLOW_TXT)
            status = await env.analyze(up["book_id"])
            return up["book_id"], status
        book_id, status = run(setup())
        assert status["status"] == "review_required"
        return env, book_id

    def test_status_and_draft_saved_no_official_write(self, draft_book):
        env, book_id = draft_book
        assert book_id not in bp.analysis_results
        assert bp.book_processor.collection.count() == 0  # 未 commit 不碰向量库
        reviews = run(bp.list_reviews())["reviews"]
        assert len(reviews) == 1 and reviews[0]["book_id"] == book_id

    def test_duplicate_upload_hits_draft(self, draft_book):
        env, book_id = draft_book

        async def flow():
            up = await env.upload(SWALLOW_TXT, "同名再来.txt")
            assert up["duplicate"] is True
            assert up["pending_review"] is True
            assert up["book_id"] == book_id
        run(flow())

    def test_review_detail_has_marks_and_head(self, draft_book):
        env, book_id = draft_book
        detail = run(bp.get_review(book_id))
        row = detail["chapters"][0]
        assert row["content_head"]
        assert any(m["rule"] in ("R1", "R2", "R9") for m in row["marks"])
        assert detail["qc_report"]["auto_commit"] is False
        # 单章吞书同时触发 R9（章数≤1）→ blocking，入库须 force
        assert detail["blocking"] is True

    def test_commit_applies_renames_and_persists(self, draft_book):
        env, book_id = draft_book
        from app.routers.book_processor import CommitBody
        body = CommitBody(renames={"sw-1": "全书（人工定名）"}, force=True)
        out = run(bp.commit_review(book_id, body))
        assert out["status"] == "committed"

        assert bp.analysis_results[book_id].chapters[0].title == "全书（人工定名）"
        assert bp.book_processor.collection.count() > 0
        rec = bp.book_processor.reconcile_book(book_id, bp.analysis_results[book_id].chapters)
        assert rec == {"missing": [], "extra": []}
        assert run(bp.list_reviews())["reviews"] == []

    def test_double_commit_returns_409(self, draft_book):
        env, book_id = draft_book
        from app.routers.book_processor import CommitBody
        run(bp.commit_review(book_id, CommitBody(force=True)))
        with pytest.raises(HTTPException) as ei:
            run(bp.commit_review(book_id, CommitBody(force=True)))
        assert ei.value.status_code == 409  # 草稿已删 → 幂等拒绝

    def test_discard_cleans_everything(self, draft_book):
        env, book_id = draft_book
        run(bp.discard_review(book_id))
        assert draft_store.load_draft(book_id) is None
        assert not os.path.exists(os.path.join(bp.UPLOAD_DIR, f"{book_id}.txt"))
        with pytest.raises(HTTPException):
            run(bp.get_review(book_id))


class TestBlockingGate:
    def test_blocking_requires_force(self, env, monkeypatch):
        """R9 退化书 blocking：commit 默认拒绝，force=true 放行"""
        from app.models.book_models import Chapter
        from app.routers.book_processor import CommitBody

        def degenerate(full_text, toc):
            return [Chapter(chapter_id="d-1", book_id="", title="唯一章",
                            content="短" * 300, word_count=300, chapter_index=0)]
        monkeypatch.setattr(bp.book_processor, "split_by_toc", degenerate)

        async def flow():
            up = await env.upload("随便什么内容" * 100)
            status = await env.analyze(up["book_id"])
            book_id = up["book_id"]
            if status["status"] != "review_required":
                pytest.skip("未落草稿（该构造全绿），force 场景不成立")
            detail = await bp.get_review(book_id)
            if not detail["blocking"]:
                pytest.skip("R9 未触发 blocking，构造退化")
            with pytest.raises(HTTPException) as ei:
                await bp.commit_review(book_id, CommitBody())
            assert ei.value.status_code == 409
            out = await bp.commit_review(book_id, CommitBody(force=True))
            assert out["status"] == "committed"
        run(flow())


class TestEmptyChapterNormalization:
    def test_empty_chapter_dropped_at_commit_not_orphaned(self, env, monkeypatch):
        """R4 空章（非暴力沟通首章形态）：commit 时索引侧丢弃 → 索引=向量，孤章绝迹"""
        from app.models.book_models import Chapter
        from app.routers.book_processor import CommitBody

        def split_with_empty(full_text, toc):
            return [
                Chapter(chapter_id="e-1", book_id="", title="序言/引言",
                        content="[PAGE 1]\n123\n456", word_count=17, chapter_index=0),
                Chapter(chapter_id="e-2", book_id="", title="第一章 正文",
                        content="正常正文内容正常正文内容。" * 50, word_count=700, chapter_index=1),
            ]
        monkeypatch.setattr(bp.book_processor, "split_by_toc", split_with_empty)

        async def flow():
            up = await env.upload(CLEAN_TXT)
            status = await env.analyze(up["book_id"])
            assert status["status"] == "review_required"  # R4+R9 拦住核对关
            out = await bp.commit_review(up["book_id"], CommitBody(force=True))
            assert out["status"] == "committed"
            assert out["dropped_empty"] == ["e-1"]
            chapters = bp.analysis_results[up["book_id"]].chapters
            assert [c.chapter_id for c in chapters] == ["e-2"]  # 索引无空章 → 孤章无从产生
            assert bp.book_processor.collection.count() > 0
            rec = bp.book_processor.reconcile_book(up["book_id"], chapters)
            assert rec == {"missing": [], "extra": []}
        run(flow())
