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
        p = tts_service.podcast_audio_name("b", "主题", 20)
        assert p == tts_service.podcast_audio_name("b", "主题", 20)     # v2.8-B：同书+主题+时长必复用
        assert p != tts_service.podcast_audio_name("b", "主题", 30)
        assert p != tts_service.podcast_audio_name("b", "换个主题", 20)
        assert p != tts_service.podcast_audio_name("b", "主题", 20, nonce="1700000000")  # regen 另起新期


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
        # v2.8-A 并发后完成序≠台词序，只断言进度计数完整
        assert sorted(i for i, _ in progress) == [1, 2] and all(n == 2 for _, n in progress)
        assert len(raw) > 4000
        # 合法 MP3：ID3 头或帧同步头（ff ex）
        assert raw[:3] == b"ID3" or (raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0)


# ---------------- v2.8-A 并发合成（假合成器，测保序/重试/失败不留半成品） ----------------

class TestSynthConcurrency:
    def test_out_of_order_completion_concat_in_script_order(self, tmp_data, monkeypatch):
        """首段故意合成最慢：并发完成序被打乱，成品仍按台词顺序拼字节；非 audio 块被过滤"""
        class FakeComm:
            def __init__(self, text, voice, **kw):
                self.text = text
            async def stream(self):
                await asyncio.sleep(0.05 if "慢" in self.text else 0.001)
                yield {"type": "WordBoundary", "data": b"ignored"}
                yield {"type": "audio", "data": f"[{self.text}]".encode()}
        monkeypatch.setattr(tts_service.edge_tts, "Communicate", FakeComm)

        async def run():
            lines = [("慢段", "A"), ("快段1", "B"), ("快段2", "A")]
            path = str(tmp_data / "c.mp3")
            prog = [p async for p in tts_service.stream_synth(lines, path)]
            return path, prog

        path, prog = asyncio.run(run())
        assert open(path, "rb").read() == "[慢段][快段1][快段2]".encode("utf-8")
        assert sorted(i for i, _ in prog) == [1, 2, 3]

    def test_segment_flaky_retry_survives(self, tmp_data, monkeypatch):
        """段级重试防线保留：瞬断 2 次第 3 次成功，整片照常落盘"""
        calls = {}
        class Flaky:
            def __init__(self, text, voice, **kw):
                self.text = text
            async def stream(self):
                calls[self.text] = calls.get(self.text, 0) + 1
                if self.text == "坏段" and calls[self.text] < 3:
                    raise RuntimeError("No audio was received")
                yield {"type": "audio", "data": self.text.encode()}
        monkeypatch.setattr(tts_service.edge_tts, "Communicate", Flaky)
        async def no_wait(_):
            return
        monkeypatch.setattr(asyncio, "sleep", no_wait)  # 免等 1s 重试间隔

        async def run():
            path = str(tmp_data / "r.mp3")
            _ = [p async for p in tts_service.stream_synth([("坏段", "A"), ("好段", "B")], path)]
            return path
        path = asyncio.run(run())
        assert calls["坏段"] == 3
        assert open(path, "rb").read() == "坏段好段".encode("utf-8")

    def test_persistent_failure_raises_no_partial_file(self, tmp_data, monkeypatch):
        """三试全败：整体抛错，正式文件与 .part 都不留"""
        class Dead:
            def __init__(self, text, voice, **kw):
                self.text = text
            async def stream(self):
                if self.text == "死段":
                    raise RuntimeError("boom")
                yield {"type": "audio", "data": self.text.encode()}
        monkeypatch.setattr(tts_service.edge_tts, "Communicate", Dead)
        async def no_wait(_):
            return
        monkeypatch.setattr(asyncio, "sleep", no_wait)

        async def run():
            path = str(tmp_data / "f.mp3")
            with pytest.raises(RuntimeError):
                _ = [p async for p in tts_service.stream_synth([("死段", "A"), ("好段", "B")], path)]
            return path
        path = asyncio.run(run())
        assert not os.path.exists(path) and not os.path.exists(path + ".part")

    def test_consumer_close_cancels_without_file(self, tmp_data, monkeypatch):
        """SSE 断连（消费方提前关闭生成器）：取消在跑任务，不产出半成品文件"""
        class Slow:
            def __init__(self, text, voice, **kw):
                self.text = text
            async def stream(self):
                await asyncio.sleep(0.5)
                yield {"type": "audio", "data": b"X"}
        monkeypatch.setattr(tts_service.edge_tts, "Communicate", Slow)

        async def run():
            path = str(tmp_data / "z.mp3")
            agen = tts_service.stream_synth([("一", "A"), ("二", "B")], path)
            first = await agen.__anext__()   # 拿到 (1,2) 后立即放弃
            await agen.aclose()
            return first, path
        first, path = asyncio.run(run())
        assert first == (1, 2)
        assert not os.path.exists(path) and not os.path.exists(path + ".part")


# ---------------- v2.8-C/D：语速停顿透传与台本审核规则 ----------------

class TestSynthRateGap:
    def test_rate_passed_through_and_gap_between_only(self, tmp_data, monkeypatch):
        """rate 逐段透传给 Communicate；gap 只在段间插，片头片尾不加"""
        seen = []
        class FakeComm:
            def __init__(self, text, voice, rate=None):
                seen.append(rate)
                self.text = text
            async def stream(self):
                yield {"type": "audio", "data": self.text.encode("utf-8")}
        monkeypatch.setattr(tts_service.edge_tts, "Communicate", FakeComm)

        async def run():
            path = str(tmp_data / "rg.mp3")
            _ = [p async for p in tts_service.stream_synth(
                [("甲", "A"), ("乙", "B"), ("丙", "A")], path, rate="+9%", gap=b"~GAP~")]
            return path
        path = asyncio.run(run())
        assert set(seen) == {"+9%"}
        data = open(path, "rb").read()
        assert data == "甲".encode("utf-8") + b"~GAP~" + "乙".encode("utf-8") + b"~GAP~" + "丙".encode("utf-8")


class TestValidateScript:
    @staticmethod
    def _lines(n, per, alt=True):
        out = []
        for i in range(n):
            voice = (tts_service.VOICE_A if i % 2 == 0 else tts_service.VOICE_B) if alt else tts_service.VOICE_A
            out.append(("话" * per, voice))
        return out

    def test_good_script_passes(self):
        # 30 段 × 90 字 = 2700 字，目标 2400：段数/字数/单条/交替全过
        assert tts_service.validate_script(self._lines(30, 90), 2400) == []

    def test_waist_cut_flagged(self):
        # 1200 字 < 2400×60% → 恰触发"腰斩"一条
        issues = tts_service.validate_script(self._lines(30, 40), 2400)
        assert len(issues) == 1

    def test_too_long_flagged(self):
        # 3600 字 > 2400×135%
        issues = tts_service.validate_script(self._lines(30, 120), 2400)
        assert len(issues) == 1

    def test_over_long_line_flagged(self):
        # 单条 130 字超上限；段数(12=2400//200)与总字数(1560≥1440)都贴线但不触发
        issues = tts_service.validate_script(self._lines(12, 130), 2400)
        assert len(issues) == 1

    def test_no_alternation_flagged(self):
        # 30 段同人连说：只触发交替一条
        issues = tts_service.validate_script(self._lines(30, 90, alt=False), 2400)
        assert len(issues) == 1

    def test_too_few_segments_flagged(self):
        # 4 段×110 字=440 字：段数不足+腰斩双触发
        issues = tts_service.validate_script(self._lines(4, 110), 2400)
        assert len(issues) == 2

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
        # v2.8-D: frame-protocol tests only; validator stubbed (rules in TestValidateScript)
        monkeypatch.setattr(tts_service, "validate_script", lambda lines, target: [])

        calls = {"synth": 0, "asset": None}

        async def fake_stream(lines, path, **kw):
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

    def test_cache_reuse_and_regen(self, tmp_data, monkeypatch):
        """v2.8-B：同书+主题+时长二次运行直接复用（不再合成、不重复归档）；
        regen=true 跳过复用另起新一期（新文件名、重新合成）"""
        calls, chapters = self._stub_common(
            monkeypatch, tmp_data, {"lines": [{"s": "A", "t": "开场"}, {"s": "B", "t": "接话"}]})

        def _audio_url(frames):
            arts = [f["artifact"] for f in frames if isinstance(f, dict) and f.get("artifact")]
            assert len(arts) == 1
            return arts[0]["data"]

        url1 = _audio_url(_parse(_collect(tools._podcast(tools.ToolRequest(**_REQ), chapters, "整本书"))))
        assert calls["synth"] == 1

        f2 = _parse(_collect(tools._podcast(tools.ToolRequest(**_REQ), chapters, "整本书")))
        assert _audio_url(f2) == url1                      # 命中缓存同 URL
        assert calls["synth"] == 1                         # 未再合成
        assert any("复用" in f.get("status", "") for f in f2 if isinstance(f, dict))

        f3 = _parse(_collect(tools._podcast(tools.ToolRequest(**_REQ, regen=True), chapters, "整本书")))
        url3 = _audio_url(f3)
        assert url3 != url1                                # regen 新一期新文件名
        assert calls["synth"] == 2                         # 重新合成
