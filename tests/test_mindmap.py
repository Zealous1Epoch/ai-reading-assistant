# -*- coding: utf-8 -*-
"""v2.1 思维导图 M1 测试：JSON 抽取 / 节点规范化 / 章节补齐 / 全书组装 / 展开端点
LLM 一律打桩，不发真实请求。运行：PYTHONPATH=backend venv/bin/pytest tests/test_mindmap.py
"""
import asyncio
import json
import sys
from pathlib import Path

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from fastapi import HTTPException  # noqa: E402

from app.routers import tools  # noqa: E402


class FakeChapter:
    def __init__(self, cid, title, content=None, index=0, book_id="bk1"):
        self.chapter_id = cid
        self.title = title
        self.content = content if content is not None else f"{title}的正文。" * 50
        self.chapter_index = index
        self.book_id = book_id


def collect(agen):
    """把异步生成器收干，返回帧 dict 列表（含 DONE 哨兵字符串）"""
    async def run():
        out = []
        async for frame in agen:
            out.append(frame)
        return out
    frames_raw = asyncio.run(run())
    parsed = []
    for f in frames_raw:
        payload = f[len("data: "):].strip()
        parsed.append(payload if payload == "[DONE]" else json.loads(payload))
    return parsed


# ---------------------------------------------------------------- JSON 抽取

class TestExtractJson:
    def test_plain(self):
        assert tools._extract_json_obj('{"t":"a"}') == {"t": "a"}

    def test_code_fence(self):
        assert tools._extract_json_obj('```json\n{"nodes":[]}\n```') == {"nodes": []}

    def test_prose_around(self):
        obj = tools._extract_json_obj('好的，结果如下：\n{"t":"章"}\n以上。')
        assert obj == {"t": "章"}

    def test_invalid_returns_none(self):
        assert tools._extract_json_obj('{"t": broken,,}') is None
        assert tools._extract_json_obj("没有 JSON") is None
        assert tools._extract_json_obj("[1,2]") is None  # 顶层必须是对象
        assert tools._extract_json_obj("") is None


class TestCleanNode:
    def test_trims_and_bounds(self):
        node = {"t": "### 标题 ###", "c": [{"t": "x" * 200}, {"t": "  "}, "垃圾", {"no_t": 1}]}
        out = tools._clean_node(node)
        assert out["t"] == "标题"  # strip('#') 清掉残留井号
        assert len(out["c"]) == 1 and len(out["c"][0]["t"]) == 80

    def test_depth_cap(self):
        deep = {"t": "1"}
        cur = deep
        for i in range(2, 10):
            cur["c"] = [{"t": str(i)}]
            cur = cur["c"][0]
        out = tools._clean_node(deep, max_depth=4)
        d, cur = 0, out
        while "c" in cur:
            cur = cur["c"][0]
            d += 1
        assert d <= 4

    def test_bad_input(self):
        assert tools._clean_node(None) is None
        assert tools._clean_node("字符串") is None
        assert tools._clean_node({"t": "   "}) is None


# ---------------------------------------------------------------- 章节补齐

class TestBookTree:
    def _chapters(self):
        return [
            FakeChapter("c1", "第一章 Introduction", index=0),
            FakeChapter("c2", "第二章 归止与皈依", index=1),
            FakeChapter("c3", "第三章 十二使徒的信条", index=2),
        ]

    def test_themes_from_response_drops_unknown(self):
        obj = {"nodes": [
            {"t": "第一章 Introduction", "c": [{"t": "理性与证据"}]},
            {"t": "幻觉出来的章节", "c": [{"t": "编的"}]},
        ]}
        wanted = {tools._norm_title(c.title) for c in self._chapters()}
        m = tools._themes_from_response(obj, wanted)
        assert list(m.keys()) == [tools._norm_title("第一章 Introduction")]
        assert m[list(m.keys())[0]][0]["t"] == "理性与证据"

    def test_build_tree_covers_all_chapters_in_order(self):
        chapters = self._chapters()
        themes_map = {
            tools._norm_title("第一章 Introduction"): [{"t": "主题A"}, {"t": "主题A"}, {"t": "主题B"}],  # 重复去重
            "不存在的章": [{"t": "该丢"}],
        }
        root = tools._build_book_tree("测试书", chapters, themes_map)
        assert root["t"] == "《测试书》"
        assert [n["t"] for n in root["c"]] == [c.title for c in chapters]  # 顺序+全量
        assert all(n["cid"] for n in root["c"])
        ch1 = root["c"][0]
        assert [t["t"] for t in ch1["c"]] == ["主题A", "主题B"]
        # LLM 漏章的两章：节点仍在，children 空（前端可点展开按需补）
        assert root["c"][1]["c"] == [] and root["c"][2]["c"] == []

    def test_fuzzy_containment_fallback(self):
        chapters = [FakeChapter("c9", "第三章 十二使徒的信条", index=0)]
        themes_map = {tools._norm_title("十二使徒的信条"): [{"t": "信条的根据"}]}
        root = tools._build_book_tree("书", chapters, themes_map)
        assert [t["t"] for t in root["c"][0]["c"]] == ["信条的根据"]


# ---------------------------------------------------------------- 工具流（打桩 LLM）

class TestMindmapStream:
    def test_whole_book_assembles_full_tree(self, monkeypatch):
        chapters = [FakeChapter(f"c{i}", f"第{i}章 章名{i}", index=i) for i in range(10)]  # 2 组
        calls = {"n": 0}

        async def fake_llm_json(prompt, attempts=2):
            calls["n"] += 1
            # 只回"第2章/第5章"两类 + 一条幻觉章：考验过滤与按组归属
            return {"nodes": [
                {"t": "第2章 章名2", "c": [{"t": "主题X"}]},
                {"t": "第5章 章名5", "c": [{"t": "主题Y"}]},
                {"t": "不存在的章", "c": [{"t": "编"}]},
            ]}

        monkeypatch.setattr(tools, "_llm_json", fake_llm_json)
        req = tools.ToolRequest(book_id="bk1")
        frames = collect(tools._mindmap(req, chapters, "整本书"))
        assert calls["n"] == 2  # MAP_GROUP_SIZE=8 → 10 章分 2 段
        art = [f for f in frames if "artifact" in f]
        assert len(art) == 1
        tree = json.loads(art[0]["artifact"]["data"])
        assert art[0]["artifact"]["type"] == "mindmap"
        assert len(tree["c"]) == 10  # 结构性零漏章
        assert [n["cid"] for n in tree["c"]] == [f"c{i}" for i in range(10)]
        assert [t["t"] for t in tree["c"][2]["c"]] == ["主题X"]
        assert [t["t"] for t in tree["c"][5]["c"]] == ["主题Y"]
        assert all("编" not in json.dumps(n, ensure_ascii=False) for n in tree["c"])
        # _mindmap 自身不发 DONE（由端点 generate 收尾），末帧应为 artifact
        assert "artifact" in frames[-1]
        # 状态帧齐全
        assert [f["status"] for f in frames if "status" in f] == ["生成骨架 1/2 段", "生成骨架 2/2 段", "组装结构树"]

    def test_single_chapter_json_artifact(self, monkeypatch):
        async def fake_llm_json(prompt, attempts=2):
            return {"t": "被改写的章名", "c": [{"t": "主题", "c": [{"t": "论点", "c": [{"t": "论据"}]}]}]}

        monkeypatch.setattr(tools, "_llm_json", fake_llm_json)
        ch = FakeChapter("c1", "第一章 真名")
        frames = collect(tools._mindmap(tools.ToolRequest(book_id="bk1"), [ch], ch.title))
        art = [f for f in frames if "artifact" in f]
        assert len(art) == 1
        node = json.loads(art[0]["artifact"]["data"])
        assert node["t"] == "第一章 真名"  # 标题锚定，不吃 LLM 改写
        assert node["cid"] == "c1"
        assert node["c"][0]["c"][0]["c"][0]["t"] == "论据"

    def test_single_chapter_falls_back_to_markdown(self, monkeypatch):
        async def fake_llm_json(prompt, attempts=2):
            return None  # JSON 两次都失败

        seen = {"fallback": False}

        async def fake_stream_prompt(prompt):
            seen["fallback"] = True
            yield tools._frame({"content": "# 大纲降级"})

        monkeypatch.setattr(tools, "_llm_json", fake_llm_json)
        monkeypatch.setattr(tools, "_stream_prompt", fake_stream_prompt)
        ch = FakeChapter("c1", "第一章")
        frames = collect(tools._mindmap(tools.ToolRequest(book_id="bk1"), [ch], ch.title))
        assert seen["fallback"] is True
        assert any("content" in f for f in frames)
        assert any(f.get("status") == "结构树解析失败，改用大纲模式" for f in frames)

    def test_gen_subtree_rejects_overlong_depth(self, monkeypatch):
        async def fake_llm_json(prompt, attempts=2):
            return {"t": "章", "c": [{"t": "深", "c": [{"t": "到", "c": [{"t": "五", "c": [{"t": "层"}]}]}]}]}

        monkeypatch.setattr(tools, "_llm_json", fake_llm_json)
        node = asyncio.run(tools._gen_chapter_subtree("书", FakeChapter("c1", "真章名")))
        assert node["t"] == "真章名" and node["cid"] == "c1"
        d, cur = 0, node
        while "c" in cur:
            cur = cur["c"][0]
            d += 1
        assert d <= 4  # 章→主题→论点→论据封顶


# ---------------------------------------------------------------- 展开端点

class TestExpandEndpoint:
    def test_404_when_chapter_missing(self, monkeypatch):
        monkeypatch.setattr(tools.book_processor, "get_chapter_by_id", lambda cid: None)
        with pytest.raises(HTTPException) as ei:
            asyncio.run(tools.mindmap_expand_stream(tools.MindmapExpandRequest(book_id="bk1", chapter_id="nope")))
        assert ei.value.status_code == 404

    def test_404_when_chapter_belongs_to_other_book(self, monkeypatch):
        monkeypatch.setattr(
            tools.book_processor, "get_chapter_by_id",
            lambda cid: FakeChapter(cid, "x", book_id="other"))
        with pytest.raises(HTTPException) as ei:
            asyncio.run(tools.mindmap_expand_stream(tools.MindmapExpandRequest(book_id="bk1", chapter_id="c1")))
        assert ei.value.status_code == 404

    def test_streams_subtree_artifact(self, monkeypatch):
        monkeypatch.setattr(tools.book_processor, "get_chapter_by_id", lambda cid: FakeChapter(cid, "第三章"))

        async def fake_subtree(book, ch):
            return {"t": ch.title, "cid": ch.chapter_id, "c": [{"t": "主题1"}, {"t": "主题2"}]}

        monkeypatch.setattr(tools, "_gen_chapter_subtree", fake_subtree)
        resp = asyncio.run(tools.mindmap_expand_stream(tools.MindmapExpandRequest(book_id="bk1", chapter_id="c3")))

        async def drain():
            out = []
            async for f in resp.body_iterator:
                out.append(f)
            return out
        frames = collect(_aiter(asyncio.run(drain())))
        art = [f for f in frames if "artifact" in f]
        assert art and art[0]["artifact"]["type"] == "mindmap-subtree"
        node = json.loads(art[0]["artifact"]["data"])
        assert node["cid"] == "c3" and len(node["c"]) == 2
        assert frames[-1] == "[DONE]"

    def test_error_frame_on_parse_failure(self, monkeypatch):
        monkeypatch.setattr(tools.book_processor, "get_chapter_by_id", lambda cid: FakeChapter(cid, "第三章"))

        async def fake_subtree(book, ch):
            return None

        monkeypatch.setattr(tools, "_gen_chapter_subtree", fake_subtree)
        resp = asyncio.run(tools.mindmap_expand_stream(tools.MindmapExpandRequest(book_id="bk1", chapter_id="c3")))

        async def drain():
            out = []
            async for f in resp.body_iterator:
                out.append(f)
            return out
        frames = collect(_aiter(asyncio.run(drain())))
        assert any("error" in f for f in frames)
        assert not any("artifact" in f for f in frames)


def _aiter(raw_frames):
    """把已收好的帧列表包回异步生成器，复用 collect 解析"""
    async def gen():
        for f in raw_frames:
            yield f
    return gen()
