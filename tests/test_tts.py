"""v2.5 听书 + 播客单测：文本清洗 / 台本解析 / 命名缓存 / /audio 路由 / podcast 工具帧协议

除 stream_synth 的真实合成冒烟外全部离线：LLM、edge-tts 合成都可打桩。
"""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from app.config import get_settings
from app.services import tts_service, asset_store
from app.routers import audio, tools


@pytest.fixture
def tmp_data(monkeypatch, tmp_path):
    stub = SimpleNamespace(data_dir=str(tmp_path))
    monkeypatch.setattr(tts_service, "settings", stub)
    monkeypatch.setattr(asset_store, "settings", stub)
    return tmp_path


# ---------------- 纯函数 ----------------

class TestTextAndNames:
    def test_clean_for_tts(self):
        raw = "# 标题行\n**加粗**与`代码`文本\n\n\n---\n正文段落\n> 引用"
        out = tts_service.clean_for_tts(raw)
        assert "#" not in out and "**" not in out and "`" not in out
        assert "---" not in out and ">" not in out
        assert "标题行" in out and "正文段落" in out

    def test_clean_cap_adds_tail(self):
        out = tts_service.clean_for_tts("字" * 30000, cap=1000)
        assert out.endswith("您可以继续阅读文字版。）")
        assert len(out) < 1200

    def test_names_deterministic_and_content_sensitive(self):
        n1 = tts_service.chapter_audio_name("b", "c", "文本一")
        assert n1 == tts_service.chapter_audio_name("b", "c", "文本一")
        assert n1 != tts_service.chapter_audio_name("b", "c", "文本二")
        assert len(n1) == 44 and n1.endswith(".mp3")
        p = tts_service.podcast_audio_name("b", "主题", 20, "{}")
        assert p != tts_service.podcast_audio_name("b", "主题", 30, "{}")


class TestScriptParsing:
    def test_parse_ok_with_fence_and_noise(self):
        raw = '好的：```json\n{"lines":[{"s":"A","t":"开场"},{"s":"女主播","t":"追问"},{"s":"B","t":"  "},{"s":"A","t":""}]}\n```完毕'
        lines = tts_service.parse_podcast_script(raw)
        assert lines is not None and len(lines) == 2      # 空 t 与纯空白被丢
        assert lines[0][1] == tts_service.VOICE_A
        assert lines[1][1] == tts_service.VOICE_B          # "女主播" 归 B

    def test_lines_from_obj_guards(self):
        assert tts_service.lines_from_obj(None) is None
        assert tts_service.lines_from_obj({"lines": "x"}) is None
        assert tts_service.lines_from_obj({"lines": [{"s": "A", "t": ""}]}) is None

    def test_parse_bad_json(self):
        assert tts_service.parse_podcast_script("没有花括号") is None
        assert tts_service.parse_podcast_script('{"lines": [1, 2]}') is None


# ---------------- 真实合成冒烟（微软免费接口，不依赖 DeepSeek） ----------------

class TestRealSynth:
    def test_stream_synth_concat(self, tmp_data):
        async def run():
            lines = [("第一段台词。", tts_service.VOICE_A), ("第二段台词。", tts_service.VOICE_B)]
            path = os.path.join(tmp_data, "x.mp3")
            progress = []
            async for i, n in tts_service.stream_synth(lines, path):
                progress.append((i, n))
            return path, progress

        path, progress = asyncio.run(run())
        raw = open(path, "rb").read()
        assert progress == [(1, 2), (2, 2)]
        assert len(raw) > 4000
        # 合法 MP3：ID3 头或帧同步头（ff ex）
        assert raw[:3] == b"ID3" or (raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0)


# ---------------- /audio 路由 ----------------

def _fake_chapter(content="正文内容"):
    return SimpleNamespace(book_id="b1", chapter_id="c1", title="第一章", content=content)


class TestAudioRouter:
    def test_orphan_chapter_404(self, tmp_data, monkeypatch):
        monkeypatch.setattr(audio.book_processor, "get_chapter_by_id", lambda cid: None)
        with pytest.raises(Exception) as e:
            asyncio.run(audio.start_chapter_audio(audio.ChapterAudioRequest(book_id="b1", chapter_id="ghost")))
        assert e.value.status_code == 404

    def test_empty_content_400(self, tmp_data, monkeypatch):
        monkeypatch.setattr(audio.book_processor, "get_chapter_by_id", lambda cid: _fake_chapter("   "))
        with pytest.raises(Exception) as e:
            asyncio.run(audio.start_chapter_audio(audio.ChapterAudioRequest(book_id="b1", chapter_id="c1")))
        assert e.value.status_code == 400

    def test_task_flow_and_file(self, tmp_data, monkeypatch):
        monkeypatch.setattr(audio.book_processor, "get_chapter_by_id", lambda cid: _fake_chapter())

        async def fake_synth(text, voice, path):
            open(path, "wb").write(b"FAKEMP3BYTES")

        monkeypatch.setattr(tts_service, "synth_one", fake_synth)

        async def flow():
            d = await audio.start_chapter_audio(audio.ChapterAudioRequest(book_id="b1", chapter_id="c1"))
            assert d["status"] == "running" and d["task_id"]
            for _ in range(100):
                await asyncio.sleep(0.02)
                t = await audio.chapter_audio_task(d["task_id"])
                if t["status"] != "running":
                    break
            assert t["status"] == "done" and t["url"].startswith("/audio/file/")
            resp = await audio.audio_file(t["url"].rsplit("/", 1)[1])
            assert resp.media_type == "audio/mpeg"
            return t["url"]

        url = asyncio.run(flow())
        # 二次请求命中磁盘缓存，不再建任务
        again = asyncio.run(audio.start_chapter_audio(audio.ChapterAudioRequest(book_id="b1", chapter_id="c1")))
        assert again == {"status": "done", "url": url, "cached": True}

    def test_bad_name_and_missing_task(self, tmp_data):
        with pytest.raises(Exception) as e:
            asyncio.run(audio.audio_file("../assets.json"))
        assert e.value.status_code == 400
        with pytest.raises(Exception) as e2:
            asyncio.run(audio.chapter_audio_task("nope123"))
        assert e2.value.status_code == 404


# ---------------- podcast 工具帧协议（fake LLM + fake 合成） ----------------

def _collect(gen):
    async def run():
        frames = []
        async for f in gen:
            for line in f.split("\n"):
                if line.startswith("data: "):
                    frames.append(line[6:])
        return frames
    return asyncio.run(run())


def _parse(frames):
    out = []
    for f in frames:
        out.append("DONE" if f == "[DONE]" else json.loads(f))
    return out


_REQ = dict(book_id="b1", user_input="观察与评论", minutes=20)


class TestPodcastTool:
    def _stub_common(self, monkeypatch, tmp_data, lines_obj, synth_raises=False, existing=False):
        monkeypatch.setattr(tools, "_book_title", lambda bid: "测试书")
        chapters = [SimpleNamespace(chapter_id="c1", title="第一章", content="观察区分评论" * 50)]

        async def fake_search(query, book_ids=None, n_results=6):
            return []
        monkeypatch.setattr(tools.book_processor, "search_chapters", fake_search)

        async def fake_llm(prompt):
            return lines_obj
        monkeypatch.setattr(tools, "_llm_json", fake_llm)

        calls = {"synth": 0, "asset": None}

        async def fake_stream(lines, path):
            calls["synth"] += 1
            if synth_raises:
                raise RuntimeError("网络断了")
            open(path, "wb").write(b"MP3" * 10)
            yield len(lines), len(lines)
        monkeypatch.setattr(tts_service, "stream_synth", fake_stream)

        def fake_add(book_id, type, content, **kw):
            calls["asset"] = {"book_id": book_id, "content": content, **kw}
            return {"asset_id": "a1"}
        monkeypatch.setattr(tools.asset_store, "add_asset", fake_add)

        if existing:
            # 预置成品：需要名字可预测 → 直接跑一次拿名再判断行为，改用文件存在探测
            pass
        return calls, chapters

    def test_frames_and_auto_asset(self, tmp_data, monkeypatch):
        calls, chapters = self._stub_common(
            monkeypatch, tmp_data, {"lines": [{"s": "A", "t": "开场白"}, {"s": "B", "t": "接话"}]})
        frames = _parse(_collect(tools._podcast(tools.ToolRequest(**_REQ), chapters, "整本书")))
        # 注：[DONE] 由 run_tool_stream 外层补发，直调 _podcast 看不到——只断言产物序列
        errs = [f for f in frames if isinstance(f, dict) and "error" in f]
        assert not errs
        arts = [f["artifact"] for f in frames if isinstance(f, dict) and f.get("artifact")]
        assert len(arts) == 1 and arts[0]["type"] == "audio"
        assert arts[0]["data"].startswith("/audio/file/") and len(arts[0]["data"]) == 44 + len("/audio/file/")
        assert calls["synth"] == 1
        # 自动归档：output_type=audio、内容即播放 URL
        assert calls["asset"]["output_type"] == "audio"
        assert calls["asset"]["content"] == arts[0]["data"]
        assert calls["asset"]["title"].startswith("播客 ·")
        assert any("资产区" in f.get("status", "") for f in frames if isinstance(f, dict))

    def test_script_parse_fail(self, tmp_data, monkeypatch):
        calls, chapters = self._stub_common(monkeypatch, tmp_data, None)
        frames = _parse(_collect(tools._podcast(tools.ToolRequest(**_REQ), chapters, "整本书")))
        assert any("error" in f for f in frames if isinstance(f, dict))
        assert calls["synth"] == 0 and calls["asset"] is None

    def test_no_topic_short_circuit(self, tmp_data):
        frames = _parse(_collect(tools._podcast(
            tools.ToolRequest(book_id="b1", user_input="  "), [], "整本书")))
        assert any("主题" in f.get("content", "") for f in frames if isinstance(f, dict))

    def test_synth_error_no_asset(self, tmp_data, monkeypatch):
        calls, chapters = self._stub_common(
            monkeypatch, tmp_data, {"lines": [{"s": "A", "t": "x" * 50}]}, synth_raises=True)
        frames = _parse(_collect(tools._podcast(tools.ToolRequest(**_REQ), chapters, "整本书")))
        assert any("语音合成失败" in f.get("error", "") for f in frames if isinstance(f, dict))
        assert calls["asset"] is None
