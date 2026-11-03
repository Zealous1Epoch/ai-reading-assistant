"""对话会话（chat_store + /sessions + 流接口持久化）测试"""

import sys
from pathlib import Path

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.services import chat_store

pytest_plugins = ('pytest_asyncio',)


@pytest.fixture
def store_env(tmp_path, monkeypatch):
    """把会话文件指向临时目录，测试互不污染"""
    fake = type("S", (), {"data_dir": str(tmp_path)})()
    monkeypatch.setattr(chat_store, "settings", fake)
    return tmp_path


class TestChatStore:
    def test_create_and_get(self, store_env):
        s = chat_store.create_session(book_id="b1", scope="book")
        assert s["title"] == "新对话"
        assert s["messages"] == []
        got = chat_store.get_session(s["session_id"])
        assert got["book_id"] == "b1"

    def test_append_sets_title_and_order(self, store_env):
        s = chat_store.create_session(book_id="b1")
        chat_store.append_messages(s["session_id"], [{"role": "user", "content": "非暴力沟通里" + "观察" * 30}])
        chat_store.append_messages(s["session_id"], [{"role": "assistant", "content": "回答内容", "sources": [{"title": "第一章"}]}])
        got = chat_store.get_session(s["session_id"])
        assert [m["role"] for m in got["messages"]] == ["user", "assistant"]
        assert got["messages"][1]["sources"][0]["title"] == "第一章"
        # 标题取首条用户消息前 24 字 + 省略号
        assert got["title"].startswith("非暴力沟通里")
        assert got["title"].endswith("…")
        assert len(got["title"]) == 25

    def test_list_filters_and_sorts(self, store_env):
        a = chat_store.create_session(book_id="b1")
        b = chat_store.create_session(book_id="b2")
        c = chat_store.create_session(scope="cross")
        # b 最后更新 → 排最前
        chat_store.append_messages(b["session_id"], [{"role": "user", "content": "x" * 3}])
        ids = [s["session_id"] for s in chat_store.list_sessions(scope="book")]
        assert ids[0] == b["session_id"]
        assert set(ids) == {a["session_id"], b["session_id"]}
        assert [s["session_id"] for s in chat_store.list_sessions(scope="cross")] == [c["session_id"]]
        assert [s["session_id"] for s in chat_store.list_sessions(book_id="b1", scope="book")] == [a["session_id"]]
        # 列表是瘦身版：无消息正文、有计数
        assert "messages" not in chat_store.list_sessions()[0]
        assert chat_store.list_sessions()[0]["message_count"] in (0, 1)

    def test_delete_and_cascade(self, store_env):
        s1 = chat_store.create_session(book_id="bx")
        s2 = chat_store.create_session(book_id="bx")
        s3 = chat_store.create_session(book_id="by")
        assert chat_store.delete_session(s1["session_id"]) is True
        assert chat_store.delete_session(s1["session_id"]) is False
        assert chat_store.delete_sessions_for_book("bx") == 1
        assert chat_store.get_session(s3["session_id"]) is not None

    def test_append_to_missing_session(self, store_env):
        assert chat_store.append_messages("nope", [{"role": "user", "content": "x"}]) is None


class TestStreamPersistence:
    """流式对话接口的会话落盘（伪造 LLM 流，不发真实请求）

    绕开 TestClient/httpx 版本兼容问题：直接调端点函数并迭代
    StreamingResponse.body_iterator，验证的是同一套逻辑。
    """

    @staticmethod
    def _drive_stream(monkeypatch, chunks, session_id, message="测试提问"):
        import asyncio
        import app.routers.analysis as analysis_mod

        async def fake_stream(message=None, chapter_context=None, chat_history=None, system_prompt_override=None):
            for c in chunks:
                yield c

        monkeypatch.setattr(analysis_mod.analysis_service, "stream_chat", fake_stream)

        async def run():
            req = analysis_mod.ChatRequest(message=message, session_id=session_id)
            resp = await analysis_mod.stream_chat(req)
            return "".join([c async for c in resp.body_iterator])

        return asyncio.run(run())

    def test_user_and_assistant_persisted(self, store_env, monkeypatch):
        s = chat_store.create_session(book_id="b1")
        body = self._drive_stream(monkeypatch, ["你好", "，世界"], s["session_id"])
        assert "[DONE]" in body

        got = chat_store.get_session(s["session_id"])
        assert [m["role"] for m in got["messages"]] == ["user", "assistant"]
        assert got["messages"][1]["content"] == "你好，世界"
        assert got["title"] == "测试提问"

    def test_unknown_session_is_ignored(self, store_env, monkeypatch):
        body = self._drive_stream(monkeypatch, ["ok"], "not-exist", message="hi")
        assert "[DONE]" in body  # 不因坏 session_id 崩掉流
