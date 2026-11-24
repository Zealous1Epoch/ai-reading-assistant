"""逐题引导会话（v3.4）：guide_store 门禁 / guides 路由硬门禁与防剧透（fake LLM 零真机）

TestClient 在本机 httpx 版本下不可构造（见项目记忆）——端点函数直调 + 手动消费 SSE body_iterator。
"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from fastapi import HTTPException

from app.services import guide_store
from app.routers import guides as guides_mod


@pytest.fixture
def store_env(tmp_path, monkeypatch):
    fake = type("S", (), {"data_dir": str(tmp_path)})()
    monkeypatch.setattr(guide_store, "settings", fake)
    return tmp_path


# ---------------------------------------------------------------- store 门禁

class TestStore:
    def test_create_drops_blank_questions(self, store_env):
        g = guide_store.create_guide("b1", "questions", "T",
                                     [{"q": "问1", "pointer": "章一"}, {"q": "  ", "pointer": ""}, {"q": "问2"}])
        assert len(g["questions"]) == 2 and len(g["per_q"]) == 2
        assert g["strict"] is True

    def test_strict_gate_requires_summary(self, store_env):
        g = guide_store.create_guide("b1", "questions", "T", [{"q": "a"}, {"q": "b"}])
        assert guide_store.can_advance(g, 0) is False
        guide_store.append_turn(g["guide_id"], 0, "reader", "我的想法")
        g = guide_store.get_guide(g["guide_id"])
        assert guide_store.can_advance(g, 0) is False   # 光答不够，strict 必须小结
        guide_store.set_summary(g["guide_id"], 0, "本题小结")
        g = guide_store.get_guide(g["guide_id"])
        assert guide_store.can_advance(g, 0) is True
        g = guide_store.advance(g["guide_id"])
        assert g["current_index"] == 1

    def test_soft_lead_always_advanceable(self, store_env):
        g = guide_store.create_guide("b1", "lead", "T", [{"q": "a"}], overview="概述")
        assert g["strict"] is False
        assert guide_store.can_advance(g, 0) is True    # 导读不硬卡

    def test_advance_past_last_marks_done(self, store_env):
        g = guide_store.create_guide("b1", "questions", "T", [{"q": "a"}])
        guide_store.set_summary(g["guide_id"], 0, "小结")
        g = guide_store.advance(g["guide_id"])
        assert g["status"] == "done"

    def test_jump_backward_only(self, store_env):
        g = guide_store.create_guide("b1", "questions", "T", [{"q": "a"}, {"q": "b"}, {"q": "c"}])
        guide_store.set_summary(g["guide_id"], 0, "s")
        guide_store.advance(g["guide_id"])              # → 1
        assert guide_store.jump_to(g["guide_id"], 0)["current_index"] == 0   # 回看可以
        assert guide_store.jump_to(g["guide_id"], 2) is None                 # 前跳拒绝：不许借跳越门禁
        assert guide_store.get_guide(g["guide_id"])["current_index"] == 0

    def test_delete_for_book(self, store_env):
        guide_store.create_guide("b1", "questions", "T", [{"q": "a"}])
        guide_store.create_guide("b2", "questions", "T", [{"q": "a"}])
        assert guide_store.delete_guides_for_book("b1") == 1
        assert [g["book_id"] for g in guide_store.list_guides()] == ["b2"]


# ---------------------------------------------------------------- 路由（端点直调）

class FakeCoachLLM:
    """astream：教练讲评/小结/收束流；ainvoke：全书 map 段"""
    def __init__(self, pieces=("你说对了一半，", "还差一步——去读第三章。")):
        self.pieces = pieces

    async def astream(self, messages):
        for p in self.pieces:
            yield SimpleNamespace(content=p)

    async def ainvoke(self, messages):
        return SimpleNamespace(content="段要点")


def _fake_llm_json(payload):
    class J:
        async def ainvoke(self, messages):
            return SimpleNamespace(content=json.dumps(payload, ensure_ascii=False))
    return lambda: J()


@pytest.fixture
def api(store_env, monkeypatch):
    """打桩：store 隔离 / 章节数据 / 书名 / 教练 LLM；返回 guides 模块本体"""
    chapters = [
        SimpleNamespace(chapter_id="c1", title="引言：偶像工厂", content="托克维尔观察到奇特的郁闷。" * 20),
        SimpleNamespace(chapter_id="c2", title="心中的偶像", content="东西越好越容易成为偶像。" * 20),
    ]
    monkeypatch.setattr(guides_mod.book_processor, "get_full_chapters", lambda bid: chapters)
    monkeypatch.setattr("app.routers.tools.books_index", {"b1": SimpleNamespace(title="诸神的面具")})
    from app.services import analysis_service as svc
    monkeypatch.setattr(type(svc.analysis_service), "llm", property(lambda self: FakeCoachLLM()))
    return guides_mod


def _collect_stream(resp):
    """消费 StreamingResponse 的 body_iterator，返回帧文本"""
    async def drain():
        return "".join([f async for f in resp.body_iterator])
    return asyncio.run(drain())


def _artifact_guide(sse_text):
    for line in sse_text.splitlines():
        if line.startswith("data: ") and '"artifact"' in line:
            return json.loads(line[6:])["artifact"]["data"]
    return None


def _exam_payload(n=10):
    return {"questions": [
        {"q": f"毕尔案例如何说明解除魔咒？{i}", "pointer": "心中的偶像" if i % 2 == 0 else "不存在的幻觉章"}
        for i in range(n)]}


def _start_questions(api, monkeypatch, n=10):
    monkeypatch.setattr("app.routers.tools._bounded_llm", _fake_llm_json(_exam_payload(n)))
    resp = asyncio.run(api.start_questions(api.GuideStartRequest(book_id="b1")))
    return _artifact_guide(_collect_stream(resp))


def _start_lead(api, monkeypatch):
    payload = {"pre": [{"q": "奇特的郁闷指什么？", "pointer": "引言：偶像工厂"}] * 4,
               "check": ["能否讲清三步论证"],
               "overview": "本章核心概述内容"}
    monkeypatch.setattr("app.routers.tools._bounded_llm", _fake_llm_json(payload))
    resp = asyncio.run(api.start_lead(api.GuideStartRequest(book_id="b1", chapter_id="c1")))
    return _artifact_guide(_collect_stream(resp))


class TestQuestionsFlow:
    def test_start_sanitizes_pointers(self, api, monkeypatch):
        guide = _start_questions(api, monkeypatch)
        assert guide and guide["kind"] == "questions" and guide["strict"] is True
        assert len(guide["questions"]) == 10
        pointers = {q["pointer"] for q in guide["questions"]}
        assert "不存在的幻觉章" not in pointers          # 幻觉章指路被洗掉
        assert "心中的偶像" in pointers                  # 真实章保留

    def test_start_too_few_questions_errors(self, api, monkeypatch):
        guide = _start_questions(api, monkeypatch, n=5)
        assert guide is None                             # 题数不足 → 只出 error 帧
        assert guide_store.list_guides() == []           # 不落脏会话

    def test_strict_gate_full_flow(self, api, monkeypatch):
        guide = _start_questions(api, monkeypatch)
        gid = guide["guide_id"]
        # 小结前推进 → 硬拒
        with pytest.raises(HTTPException) as e:
            asyncio.run(api.advance(gid))
        assert e.value.status_code == 409
        # 作答：读者轮 + 教练讲评流都落 turns
        resp = asyncio.run(api.reply(gid, api.ReplyRequest(q_index=0, text="我觉得是因为好东西让人不设防")))
        _collect_stream(resp)
        g = guide_store.get_guide(gid)
        roles = [t["role"] for t in g["per_q"][0]["turns"]]
        assert roles == ["reader", "coach"]
        # 只能答当前题：跳题作答被拒
        with pytest.raises(HTTPException) as e:
            asyncio.run(api.reply(gid, api.ReplyRequest(q_index=1, text="抢答")))
        assert e.value.status_code == 409
        # 小结当前题 → 落库并放行
        resp = asyncio.run(api.summarize(gid, api.QIndexRequest(q_index=0)))
        _collect_stream(resp)
        g = guide_store.get_guide(gid)
        assert g["per_q"][0]["resolved"] is True
        g = asyncio.run(api.advance(gid))
        assert g["guide"]["current_index"] == 1

    def test_summarize_requires_answer_first(self, api, monkeypatch):
        guide = _start_questions(api, monkeypatch)
        with pytest.raises(HTTPException) as e:
            asyncio.run(api.summarize(guide["guide_id"], api.QIndexRequest(q_index=0)))
        assert e.value.status_code == 409


class TestLeadFlow:
    def test_overview_hidden_until_revealed(self, api, monkeypatch):
        guide = _start_lead(api, monkeypatch)
        assert guide and guide["overview"] == ""         # 接口层剥剧透
        assert guide["strict"] is False
        gid = guide["guide_id"]
        with pytest.raises(HTTPException) as e:          # 未走完揭示 → 409
            asyncio.run(api.reveal(gid))
        assert e.value.status_code == 409
        for _ in guide["questions"]:                     # 软模式：连续推进到 done
            asyncio.run(api.advance(gid))
        assert guide_store.get_guide(gid)["status"] == "done"
        r = asyncio.run(api.reveal(gid))
        assert r["overview"] == "本章核心概述内容"

    def test_checklist_persisted(self, api, monkeypatch):
        guide = _start_lead(api, monkeypatch)
        assert guide["check"] == ["能否讲清三步论证"]


class TestClosing:
    def test_closing_requires_done_then_persists(self, api):
        g = guide_store.create_guide("b1", "questions", "T", [{"q": "a"}])
        with pytest.raises(HTTPException) as e:
            asyncio.run(api.closing(g["guide_id"]))
        assert e.value.status_code == 409
        guide_store.set_summary(g["guide_id"], 0, "s")
        asyncio.run(api.advance(g["guide_id"]))
        resp = asyncio.run(api.closing(g["guide_id"]))
        _collect_stream(resp)
        assert guide_store.get_guide(g["guide_id"])["closing"].strip()   # 收束清单落库
