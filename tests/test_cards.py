"""知识卡片（v2.3）：card_store Leitner 排期 / 去重 / 到期队列 / Anki 导出 / 端点冒烟 / 抽卡工具帧协议"""

import asyncio
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.services import card_store

pytest_plugins = ('pytest_asyncio',)


@pytest.fixture
def store_env(tmp_path, monkeypatch):
    fake = type("S", (), {"data_dir": str(tmp_path)})()
    monkeypatch.setattr(card_store, "settings", fake)
    return tmp_path


def _set_next_review(card_id, day):
    """直接改存储里的到期日，构造到期/未到期场景"""
    data = card_store._load()
    data[card_id]["next_review"] = day.isoformat()
    card_store._save(data)


class TestCardStore:
    def test_add_fields_and_due_today(self, store_env):
        r = card_store.add_cards("b1", [{"front": "Q1", "back": "A1", "cite": "原句"}],
                                 chapter_id="c1", chapter_title="第一章")
        assert r["added"] == 1 and r["skipped"] == 0
        card = r["cards"][0]
        assert card["box"] == 1
        # 新卡当天即到期（抽完就能复习）
        assert card["next_review"] == date.today().isoformat()
        assert card["chapter_title"] == "第一章"

    def test_dedup_and_invalid(self, store_env):
        card_store.add_cards("b1", [{"front": "什么是观察", "back": "A"}])
        r = card_store.add_cards("b1", [
            {"front": "  什么是观察  ", "back": "换个空格也算重复"},   # 去空白精确重复 → skip
            {"front": "", "back": "空 front"},                        # skip
            {"front": "有效卡", "back": ""},                          # 空 back → skip
            {"front": "另一问", "back": "B"},                          # 新增
        ])
        assert r["added"] == 1 and r["skipped"] == 3
        # 跨书不去重：另一本书同 front 照收
        r2 = card_store.add_cards("b2", [{"front": "什么是观察", "back": "A"}])
        assert r2["added"] == 1

    def test_leitner_progression(self, store_env):
        card = card_store.add_cards("b1", [{"front": "Q", "back": "A"}])["cards"][0]
        cid, today = card["card_id"], date.today()
        # good: box 1→2，间隔 2 天
        c = card_store.grade_card(cid, "good")
        assert c["box"] == 2 and c["next_review"] == (today + timedelta(days=2)).isoformat()
        assert c["correct"] == 1 and c["wrong"] == 0
        # again: 回 box1，明天
        c = card_store.grade_card(cid, "again")
        assert c["box"] == 1 and c["next_review"] == (today + timedelta(days=1)).isoformat()
        assert c["wrong"] == 1
        # easy: +2 格
        c = card_store.grade_card(cid, "easy")
        assert c["box"] == 3 and c["next_review"] == (today + timedelta(days=4)).isoformat()
        # 顶格：box3 easy→5（+2 封顶），再 good 仍 5（间隔 15 天）
        card_store.grade_card(cid, "easy")   # →5
        c = card_store.grade_card(cid, "good")
        assert c["box"] == 5 and c["next_review"] == (today + timedelta(days=15)).isoformat()
        assert c["reviews"] == 5

    def test_grade_invalid_and_missing(self, store_env):
        with pytest.raises(ValueError):
            card_store.grade_card("nope", "mega")
        assert card_store.grade_card("nope", "good") is None

    def test_due_queue_hard_first(self, store_env):
        today = date.today()
        a = card_store.add_cards("b1", [{"front": "A", "back": "x"}])["cards"][0]
        b = card_store.add_cards("b1", [{"front": "B", "back": "x"}])["cards"][0]
        c = card_store.add_cards("b1", [{"front": "C", "back": "x"}])["cards"][0]
        _set_next_review(a["card_id"], today + timedelta(days=3))     # 未到期
        _set_next_review(b["card_id"], today - timedelta(days=2)); card_store._load()
        data = card_store._load(); data[b["card_id"]]["box"] = 3; card_store._save(data)
        _set_next_review(c["card_id"], today - timedelta(days=1))     # 到期 box1
        due = card_store.due_cards("b1")
        # 到期= b、c；难卡（低盒）优先 → c(box1) 在 b(box3) 前
        assert [x["front"] for x in due] == ["C", "B"]
        s = card_store.stats("b1")
        assert s == {"total": 3, "due": 2}

    def test_delete_and_cascade(self, store_env):
        card_store.add_cards("b1", [{"front": "A", "back": "x"}, {"front": "B", "back": "y"}])
        card_store.add_cards("b2", [{"front": "C", "back": "z"}])
        one = card_store.list_cards("b1")[0]
        assert card_store.delete_card(one["card_id"]) is True
        assert card_store.delete_card("nope") is False
        assert card_store.stats("b1")["total"] == 1
        assert card_store.delete_cards_for_book("b1") == 1
        assert card_store.stats("b1")["total"] == 0
        assert card_store.stats("b2")["total"] == 1

    def test_anki_tsv(self, store_env):
        card_store.add_cards("b1", [{"front": "问 题\n第二行", "back": "答\n案"}])
        tsv = card_store.anki_tsv("b1", title_of=lambda bid: "非暴力 沟通")
        lines = tsv.strip().split("\n")
        assert len(lines) == 1
        cols = lines[0].split("\t")
        assert cols[0] == "问 题<br>第二行" and cols[1] == "答<br>案"
        assert cols[2] == "非暴力_沟通"   # Anki 标签无空格


class TestCardsRouter:
    """端点函数直调（TestClient 在本机 httpx 下会炸——见项目记忆 v1.5）"""

    def _router(self):
        from app.routers import cards
        return cards

    def test_grade_validation(self, store_env):
        cards = self._router()
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as e:
            asyncio.run(cards.grade_card("x", cards.GradeRequest(result="mega")))
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            asyncio.run(cards.grade_card("nope", cards.GradeRequest(result="good")))
        assert e.value.status_code == 404
        card = card_store.add_cards("b1", [{"front": "Q", "back": "A"}])["cards"][0]
        r = asyncio.run(cards.grade_card(card["card_id"], cards.GradeRequest(result="good")))
        assert r["ok"] is True and r["card"]["box"] == 2

    def test_stats_and_export(self, store_env):
        cards = self._router()
        from fastapi import HTTPException
        r = asyncio.run(cards.card_stats())
        assert r == {"stats": {}, "total": 0, "due": 0}
        with pytest.raises(HTTPException) as e:
            asyncio.run(cards.export_anki(None))
        assert e.value.status_code == 404
        card_store.add_cards("b1", [{"front": "Q1", "back": "A1"}])
        resp = asyncio.run(cards.export_anki("b1"))
        body = resp.body.decode("utf-8")
        assert "Q1\tA1" in body


class TestCardsTool:
    """抽卡工具：帧协议 + 入库 + 重复跳过（LLM 与检索全部打桩）"""

    def _ch(self, cid, title, body=None):
        return SimpleNamespace(chapter_id=cid, title=title, content=body or (title + "的内容。" * 80))

    def _drive(self, gen):
        async def collect():
            return [f async for f in gen]
        return asyncio.run(collect())

    def _frames_json(self, frames):
        out = []
        for f in frames:
            payload = f[len("data: "):].strip()
            if payload != "[DONE]":
                out.append(json.loads(payload))
        return out

    def test_single_chapter_flow(self, store_env, monkeypatch):
        from app.routers import tools as T
        fake = {"cards": [
            {"front": "观察与评论的区别", "back": "观察描述事实，评论下判断", "cite": "我从未见过…"},
            {"front": "", "back": "无效"},
        ]}
        async def fake_llm(prompt, attempts=2):
            return fake
        monkeypatch.setattr(T, "_llm_json", fake_llm)
        req = SimpleNamespace(book_id="b1", chapter_id="c1")
        frames = self._frames_json(self._drive(
            T._cards(req, [self._ch("c1", "第一章")], "第一章")))
        # 进度帧 + 入库说明帧 + artifact 帧
        assert any(f.get("status", "").startswith("提炼卡片") for f in frames)
        assert any("已存入 1 张" in f.get("status", "") for f in frames)
        art = next(f["artifact"] for f in frames if "artifact" in f)
        assert art["type"] == "cards"
        data = json.loads(art["data"])
        assert len(data["cards"]) == 1 and data["cards"][0]["front"] == "观察与评论的区别"
        # 归属到抽取的那一章
        assert data["cards"][0]["chapter_title"] == "第一章"
        # 真的进了复习库
        assert card_store.stats("b1")["total"] == 1

    def test_rerun_all_duplicate(self, store_env, monkeypatch):
        from app.routers import tools as T
        fake = {"cards": [{"front": "Q", "back": "A"}]}
        async def fake_llm(prompt, attempts=2):
            return fake
        monkeypatch.setattr(T, "_llm_json", fake_llm)
        req = SimpleNamespace(book_id="b1", chapter_id="c1")
        args = (req, [self._ch("c1", "第一章")], "第一章")
        self._drive(T._cards(*args))
        frames = self._frames_json(self._drive(T._cards(*args)))
        assert any("跳过 1 张重复" in f.get("status", "") for f in frames)
        assert card_store.stats("b1")["total"] == 1

    def test_llm_fail_error_frame(self, store_env, monkeypatch):
        from app.routers import tools as T
        async def fake_llm(prompt, attempts=2):
            return None
        monkeypatch.setattr(T, "_llm_json", fake_llm)
        req = SimpleNamespace(book_id="b1", chapter_id="c1")
        frames = self._frames_json(self._drive(
            T._cards(req, [self._ch("c1", "第一章")], "第一章")))
        assert any("error" in f for f in frames)
        assert card_store.stats("b1")["total"] == 0

    def test_book_scope_grouping_and_cap(self, store_env, monkeypatch):
        from app.routers import tools as T
        n_calls = []
        async def fake_llm(prompt, attempts=2):
            n_calls.append(prompt)
            return {"cards": [{"front": f"组{len(n_calls)}卡{i}", "back": "A"} for i in range(10)]}
        monkeypatch.setattr(T, "_llm_json", fake_llm)
        chapters = [self._ch(f"c{i}", f"第{i}章") for i in range(1, 11)]  # 10 章 → 2 组
        req = SimpleNamespace(book_id="b1", chapter_id=None)
        frames = self._frames_json(self._drive(T._cards(req, chapters, "整本书")))
        # 全书每组只归组第一章（卡不挂单章）
        data = json.loads(next(f["artifact"] for f in frames if "artifact" in f)["data"])
        assert all(c["chapter_title"] is None for c in data["cards"])
        # 全书每组 3 张：实际入库 ≤ 3/组；10 章 2 组 → 6 张
        assert card_store.stats("b1")["total"] == 6
        assert len(n_calls) == 2
