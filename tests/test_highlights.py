"""划线高亮（v2.7）：highlight_store 去重/过滤/级联 + 路由直调冒烟（零 LLM）"""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.services import highlight_store


@pytest.fixture
def store_env(tmp_path, monkeypatch):
    fake = type("S", (), {"data_dir": str(tmp_path)})()
    monkeypatch.setattr(highlight_store, "settings", fake)
    return tmp_path


class TestHighlightStore:
    def test_add_fields(self, store_env):
        h = highlight_store.add_highlight("b1", "c1", 3, "爱是专注地凝视", chapter_title="第三章")
        assert h["highlight_id"]
        assert h["book_id"] == "b1" and h["chapter_id"] == "c1"
        assert h["start_p"] == 3 and h["text"] == "爱是专注地凝视"
        assert h["chapter_title"] == "第三章"
        assert h["created_at"]

    def test_empty_text_rejected(self, store_env):
        assert highlight_store.add_highlight("b1", "c1", 0, "") is None
        assert highlight_store.add_highlight("b1", "c1", 0, "   \n  ") is None

    def test_dedup_idempotent(self, store_env):
        h1 = highlight_store.add_highlight("b1", "c1", 2, "观察 而不评价")
        # 同书同章同段同文（空白差异）→ 返回既有条目，不新增
        h2 = highlight_store.add_highlight("b1", "c1", 2, "观察而不评价")
        assert h2["highlight_id"] == h1["highlight_id"]
        assert len(highlight_store.list_highlights("b1")) == 1
        # 不同段 / 不同章 / 不同书 → 各自新增
        assert highlight_store.add_highlight("b1", "c1", 5, "观察而不评价") is not None
        assert highlight_store.add_highlight("b1", "c2", 2, "观察而不评价") is not None
        assert highlight_store.add_highlight("b2", "c1", 2, "观察而不评价") is not None
        assert len(highlight_store.list_highlights("b1")) == 3
        assert len(highlight_store.list_highlights("b2")) == 1

    def test_text_cap(self, store_env):
        h = highlight_store.add_highlight("b1", "c1", 0, "长" * (highlight_store.TEXT_CAP + 500))
        assert len(h["text"]) == highlight_store.TEXT_CAP

    def test_list_filters(self, store_env):
        highlight_store.add_highlight("b1", "c1", 0, "甲")
        highlight_store.add_highlight("b1", "c2", 0, "乙")
        highlight_store.add_highlight("b2", "c1", 0, "丙")
        assert len(highlight_store.list_highlights()) == 3
        # 同秒创建的多条按 uuid 序，断言用集合不比顺序
        assert {h["text"] for h in highlight_store.list_highlights(book_id="b1")} == {"甲", "乙"}
        assert [h["text"] for h in highlight_store.list_highlights(book_id="b1", chapter_id="c2")] == ["乙"]
        assert highlight_store.count_by_book() == {"b1": 2, "b2": 1}

    def test_delete_and_cascade(self, store_env):
        h = highlight_store.add_highlight("b1", "c1", 0, "待删")
        highlight_store.add_highlight("b1", "c1", 1, "级联删")
        highlight_store.add_highlight("b2", "c1", 0, "旁观")
        assert highlight_store.delete_highlight(h["highlight_id"]) is True
        assert highlight_store.delete_highlight("nope") is False
        assert highlight_store.delete_for_book("b1") == 1
        assert [x["text"] for x in highlight_store.list_highlights()] == ["旁观"]


class TestHighlightsRouter:
    """端点函数直调（TestClient 在本机 httpx 下会炸——见项目记忆 v1.5）"""

    def _router(self):
        from app.routers import highlights
        return highlights

    def test_post_validations(self, store_env, monkeypatch):
        hl = self._router()
        from fastapi import HTTPException
        # 空文本 → 400（不触章查询）
        with pytest.raises(HTTPException) as e:
            asyncio.run(hl.add_highlight(hl.HighlightRequest(
                book_id="b1", chapter_id="c1", start_p=0, text="  ")))
        assert e.value.status_code == 400
        # 章不存在 → 404
        monkeypatch.setattr(hl.book_processor, "get_chapter_by_id", lambda cid: None)
        with pytest.raises(HTTPException) as e:
            asyncio.run(hl.add_highlight(hl.HighlightRequest(
                book_id="b1", chapter_id="ghost", start_p=0, text="正文")))
        assert e.value.status_code == 404

    def test_post_success_fills_title_and_roundtrip(self, store_env, monkeypatch):
        hl = self._router()
        chap = SimpleNamespace(chapter_id="c1", title="论谦卑")
        monkeypatch.setattr(hl.book_processor, "get_chapter_by_id", lambda cid: chap)
        r = asyncio.run(hl.add_highlight(hl.HighlightRequest(
            book_id="b1", chapter_id="c1", start_p=2, text="骄傲是最大的罪")))
        assert r["ok"] is True
        # 请求未带 chapter_title → 从章节对象补齐
        assert r["highlight"]["chapter_title"] == "论谦卑"
        # 请求显式带了 chapter_title → 尊重请求值
        r2 = asyncio.run(hl.add_highlight(hl.HighlightRequest(
            book_id="b1", chapter_id="c1", start_p=4, text="另一句",
            chapter_title="读者侧标题")))
        assert r2["highlight"]["chapter_title"] == "读者侧标题"
        # GET 列表与计数徽标
        lst = asyncio.run(hl.list_highlights(book_id="b1"))
        assert lst["total"] == 2
        cnt = asyncio.run(hl.count_highlights())
        assert cnt["counts"] == {"b1": 2}
        # DELETE 正常 + 404
        from fastapi import HTTPException
        ok = asyncio.run(hl.delete_highlight(r["highlight"]["highlight_id"]))
        assert ok["ok"] is True
        with pytest.raises(HTTPException) as e:
            asyncio.run(hl.delete_highlight("nope"))
        assert e.value.status_code == 404
