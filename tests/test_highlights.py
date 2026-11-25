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

    # —— v3.6 多色高亮 + 笔记 ——

    def test_color_defaults_and_fallback(self, store_env):
        h1 = highlight_store.add_highlight("b1", "c1", 0, "甲句")
        assert h1["color"] == highlight_store.DEFAULT_COLOR
        h2 = highlight_store.add_highlight("b1", "c1", 1, "乙句", color="green")
        assert h2["color"] == "green"
        # 非法色键 → 静默回落默认（store 层防御；路由层才是 400 拒绝）
        h3 = highlight_store.add_highlight("b1", "c1", 2, "丙句", color="neon")
        assert h3["color"] == highlight_store.DEFAULT_COLOR

    def test_note_field(self, store_env):
        h = highlight_store.add_highlight("b1", "c1", 0, "有笔记", note="  很有洞见  ")
        assert h["note"] == "很有洞见"
        big = highlight_store.add_highlight("b1", "c1", 1, "长笔记", note="字" * (highlight_store.NOTE_CAP + 99))
        assert len(big["note"]) == highlight_store.NOTE_CAP
        blank = highlight_store.add_highlight("b1", "c1", 2, "空白笔记", note="   ")
        assert blank["note"] is None
        plain = highlight_store.add_highlight("b1", "c1", 3, "无笔记")
        assert plain["note"] is None

    def test_rehighlight_updates_color_and_note(self, store_env):
        h1 = highlight_store.add_highlight("b1", "c1", 2, "观察而不评价", color="amber")
        # 同文再高亮换色：不新增，既有条目变色
        h2 = highlight_store.add_highlight("b1", "c1", 2, "观察 而不评价", color="blue")
        assert h2["highlight_id"] == h1["highlight_id"] and h2["color"] == "blue"
        # 不带 color/note 的重复高亮：原样返回，颜色和笔记都不被冲掉
        h3 = highlight_store.add_highlight("b1", "c1", 2, "观察而不评价", note="记一笔")
        h4 = highlight_store.add_highlight("b1", "c1", 2, "观察而不评价")
        assert h4["highlight_id"] == h1["highlight_id"]
        assert h4["color"] == "blue" and h4["note"] == "记一笔"
        assert len(highlight_store.list_highlights("b1")) == 1

    def test_update_highlight(self, store_env):
        h = highlight_store.add_highlight("b1", "c1", 0, "待更新", note="旧笔记")
        r = highlight_store.update_highlight(h["highlight_id"], color="pink")
        assert r["color"] == "pink" and r["note"] == "旧笔记"   # 只动色不动笔记
        r = highlight_store.update_highlight(h["highlight_id"], note="")
        assert r["note"] is None and r["color"] == "pink"        # '' 清空笔记
        r = highlight_store.update_highlight(h["highlight_id"], color="bad", note="新笔记")
        assert r["color"] == highlight_store.DEFAULT_COLOR and r["note"] == "新笔记"
        assert highlight_store.update_highlight("ghost", color="amber") is None
        # 更新落盘：重载仍在
        assert highlight_store.list_highlights("b1")[0]["note"] == "新笔记"

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

    def test_v36_post_color_note_and_patch(self, store_env, monkeypatch):
        """v3.6：POST 带色带笔记、非法色 400；PATCH 换色/改笔记/空更新 400/404"""
        hl = self._router()
        from fastapi import HTTPException
        chap = SimpleNamespace(chapter_id="c1", title="第一章")
        monkeypatch.setattr(hl.book_processor, "get_chapter_by_id", lambda cid: chap)
        r = asyncio.run(hl.add_highlight(hl.HighlightRequest(
            book_id="b1", chapter_id="c1", start_p=0, text="金句",
            color="green", note="发给团契")))
        assert r["highlight"]["color"] == "green" and r["highlight"]["note"] == "发给团契"
        with pytest.raises(HTTPException) as e:
            asyncio.run(hl.add_highlight(hl.HighlightRequest(
                book_id="b1", chapter_id="c1", start_p=1, text="另一句", color="neon")))
        assert e.value.status_code == 400
        hid = r["highlight"]["highlight_id"]
        # PATCH 只换色：笔记保留
        p = asyncio.run(hl.patch_highlight(hid, hl.HighlightPatch(color="pink")))
        assert p["highlight"]["color"] == "pink" and p["highlight"]["note"] == "发给团契"
        # PATCH 清空笔记：颜色保留
        p = asyncio.run(hl.patch_highlight(hid, hl.HighlightPatch(note="")))
        assert p["highlight"]["note"] is None and p["highlight"]["color"] == "pink"
        # 空更新 → 400；非法色 → 400；不存在 → 404
        for kwargs, code in (({}, 400), ({"color": "neon"}, 400)):
            with pytest.raises(HTTPException) as e:
                asyncio.run(hl.patch_highlight(hid, hl.HighlightPatch(**kwargs)))
            assert e.value.status_code == code
        with pytest.raises(HTTPException) as e:
            asyncio.run(hl.patch_highlight("ghost", hl.HighlightPatch(color="blue")))
        assert e.value.status_code == 404
