"""AI 兜底重切单测（零 LLM：FakeLLM 预置返回；正文永不经过模型）"""

import json

import pytest

from app.models.book_models import Chapter
from app.services.resegment import (
    RESEG_EXTRA_BODY,
    HeadingCandidate,
    ai_resegment,
    extract_heading_candidates,
    split_by_candidates,
)


class FakeLLM:
    """按队列吐响应；记录 bind 参数与调用次数"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.bind_kwargs = []
        self.calls = 0

    def bind(self, **kwargs):
        self.bind_kwargs.append(kwargs)
        return self

    async def ainvoke(self, msgs):
        self.calls += 1
        content = self.responses.pop(0) if self.responses else "[]"

        class _R:
            pass
        r = _R()
        r.content = content
        return r


BOOK_TEXT = (
    "第一章 起点\n\n" + "起点处的正文内容，讲述开始的事。" * 40 + "\n\n"
    "第二章 途中\n\n" + "途中的正文内容，讲述经过的事。" * 40 + "\n\n"
    "第三章 终点\n\n" + "终点的正文内容，讲述结束的事。" * 40
)


class TestExtractCandidates:
    def test_finds_chapter_lines(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        texts = [c.text for c in cands]
        assert any("第一章 起点" in t for t in texts)
        assert any("第二章 途中" in t for t in texts)
        assert all(a.offset < b.offset for a, b in zip(cands, cands[1:]))

    def test_body_sentences_not_candidates(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        # 正文句有句末标点且长，不应入选
        assert not any("讲述" in c.text for c in cands)

    def test_doc_offsets_become_virtual_anchors(self):
        cands = extract_heading_candidates(BOOK_TEXT, doc_offsets=[300, 1500])
        src = {c.source for c in cands}
        assert "doc_start" in src
        offs = [c.offset for c in cands]
        assert 300 in offs and 1500 in offs

    def test_number_lines_only_for_epub(self):
        text = "1\n\n" + "信的内容若干信的内容若干。" * 20 + "\n\n2\n\n" + "第二封信内容若干。" * 20
        epub_c = extract_heading_candidates(text, numeric_lines=True)
        pdf_c = extract_heading_candidates(text, numeric_lines=False)
        assert any(c.text == "1" and c.source == "number_line" for c in epub_c)
        assert not any(c.text in ("1", "2") for c in pdf_c)

    def test_nearby_clustered_keep_high_score(self):
        text = "第一章 起点\n第一章 起点（重复行）\n" + "正文。" * 50
        cands = extract_heading_candidates(text)
        firsts = [c for c in cands if c.offset < 40]
        assert len(firsts) <= 1

    def test_number_line_not_bulldozed_by_adjacent_line(self):
        """魔鬼家书形态：每封信=上封落款行紧贴信首编号（间距<MIN_CAND_GAP）。
        旧聚类按分数互斥，重复落款高分吃掉编号行 → 31 封信只剩 1 个边界。
        现规则来源权重优先，编号行必须全存活。"""
        text = "".join(
            f"疼爱着你的叔叔\n\n{n}\n\n" + f"亲爱的第{n}个病人，正文内容正文内容。" * 15
            for n in range(1, 6)
        )
        cands = extract_heading_candidates(text, numeric_lines=True)
        nums = [c for c in cands if c.source == "number_line"]
        assert len(nums) == 5, [c.text for c in cands]

    def test_candidate_carries_context_preview(self):
        """候选须带下文预览：AI 靠它识别"独立编号+信抬头"这类无字面标题的边界"""
        text = "第一章 起点\n\n" + "这是一段足够长的正文用来充当上下文预览。" * 20
        cands = extract_heading_candidates(text)
        hit = next(c for c in cands if c.text.startswith("第一章"))
        assert "这是一段足够长的正文" in hit.ctx


class TestSplitByCandidates:
    def test_exact_offset_cut(self):
        from app.services.resegment import PickedChapter
        off1 = BOOK_TEXT.index("第二章 途中")
        chapters = split_by_candidates(BOOK_TEXT, [PickedChapter(offset=off1, title="途中")])
        assert len(chapters) == 2
        assert chapters[0].title == "前置内容"
        assert chapters[0].start_position == 0 and chapters[0].end_position == off1
        assert chapters[1].title == "途中"
        assert chapters[1].start_position == off1
        assert "途中的正文" in chapters[1].content
        assert "起点处的正文" in chapters[0].content

    def test_all_candidates_with_titles(self):
        from app.services.resegment import PickedChapter
        picked = [
            PickedChapter(offset=BOOK_TEXT.index("第一章 起点"), title="第一章 起点"),
            PickedChapter(offset=BOOK_TEXT.index("第二章 途中"), title="途中", level=2),
            PickedChapter(offset=BOOK_TEXT.index("第三章 终点"), title="终点"),
        ]
        chapters = split_by_candidates(BOOK_TEXT, picked)
        assert len(chapters) == 3
        assert [c.chapter_index for c in chapters] == [0, 1, 2]
        assert chapters[1].level == 2
        # 正文不经过 AI：拼接后与原文去空白一致
        joined = "".join(c.content for c in chapters)
        assert "讲述经过的事" in joined


class TestAiResegment:
    @pytest.mark.asyncio(loop_scope="function")
    async def test_valid_response_and_bind_body(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        off_map = {i: c for i, c in enumerate(cands)}
        i2 = next(i for i, c in enumerate(cands) if "第二章" in c.text)
        i3 = next(i for i, c in enumerate(cands) if "第三章" in c.text)
        fake = FakeLLM([json.dumps([
            {"cand": i2, "title": "途中章", "level": 1},
            {"cand": i3, "title": "终点章", "level": 1},
        ])])
        picked = await ai_resegment(fake, BOOK_TEXT, cands, "测试书")
        assert picked and [p.title for p in picked] == ["途中章", "终点章"]
        assert picked[0].offset == off_map[i2].offset
        # vLLM 关思考 + max_tokens 必须在同一次 bind 的 extra_body dict 里
        body = fake.bind_kwargs[0]["extra_body"]
        assert body["max_tokens"] == RESEG_EXTRA_BODY["max_tokens"]
        assert body["chat_template_kwargs"]["enable_thinking"] is False

    @pytest.mark.asyncio(loop_scope="function")
    async def test_invalid_title_falls_back_to_line_text(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        i1 = next(i for i, c in enumerate(cands) if "第一章" in c.text)
        fake = FakeLLM([json.dumps([{"cand": i1, "title": "x" * 50}])])
        picked = await ai_resegment(fake, BOOK_TEXT, cands)
        assert picked[0].title == cands[i1].text  # 超长标题回退候选行原文

    @pytest.mark.asyncio(loop_scope="function")
    async def test_retry_then_success(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        i2 = next(i for i, c in enumerate(cands) if "第二章" in c.text)
        fake = FakeLLM(["not json at all", json.dumps([{"cand": i2, "title": "途中"}])])
        picked = await ai_resegment(fake, BOOK_TEXT, cands)
        assert picked and fake.calls == 2  # 坏响应重试一次后成功

    @pytest.mark.asyncio(loop_scope="function")
    async def test_garbage_returns_none(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        fake = FakeLLM(["垃圾", "还是垃圾"])
        assert await ai_resegment(fake, BOOK_TEXT, cands) is None

    @pytest.mark.asyncio(loop_scope="function")
    async def test_out_of_range_cand_dropped(self):
        cands = extract_heading_candidates(BOOK_TEXT)
        fake = FakeLLM([json.dumps([
            {"cand": 9999, "title": "幻觉"},
            {"cand": -1, "title": "幻觉"},
        ])])
        assert await ai_resegment(fake, BOOK_TEXT, cands) is None


class TestAnalyzeBookSeparation:
    """analyze_book 必须与落库彻底分离（孤章病灶的机制性解药）"""

    @pytest.fixture
    def processor(self, tmp_path):
        from app.services.book_processor import BookProcessor
        return BookProcessor(persist_directory=str(tmp_path / "chroma_test"))

    @pytest.mark.asyncio(loop_scope="function")
    async def test_clean_book_no_resegment_no_write(self, processor, tmp_path, monkeypatch):
        """全绿小书：不触发重切、chroma 一个块都不写"""
        f = tmp_path / "good.txt"
        f.write_text(BOOK_TEXT, encoding="utf-8")

        async def fake_detect(t):
            return []
        monkeypatch.setattr(processor, "detect_toc_by_ai", fake_detect)
        processor._llm = FakeLLM([])  # 不该被调用

        pack = await processor.analyze_book(str(f), "b1")

        assert pack["resegmented"] is False
        assert pack["result"].total_chapters >= 2
        assert processor.collection.count() == 0, "analyze 阶段绝不能写向量库"

    @pytest.mark.asyncio(loop_scope="function")
    async def test_suspicious_book_triggers_resegment(self, processor, tmp_path, monkeypatch):
        """单章吞书形态（R1/R2/R9）→ 自动重切，切完变多章、报告更新"""
        long_text = ("甲部分标题\n\n" + "甲段正文内容若干甲段正文内容若干。" * 4000 + "\n\n"
                     + "乙部分标题\n\n" + "乙段正文内容若干乙段正文内容若干。" * 4000)
        f = tmp_path / "swallow.txt"
        f.write_text(long_text, encoding="utf-8")

        async def fake_detect(t):
            return []
        monkeypatch.setattr(processor, "detect_toc_by_ai", fake_detect)
        # 规则切不出：_fallback_toc_detection 对无编号短行标题可能失手，直接构造吞书结果
        from app.models.book_models import Chapter as _Ch
        swallow = [
            _Ch(chapter_id="s0", book_id="", title="整本书", content=long_text,
                word_count=len(long_text), chapter_index=0)]
        monkeypatch.setattr(processor, "split_by_toc", lambda ft, toc: list(swallow))

        off_b = long_text.index("乙部分标题")
        # 候选序号在 test 内按实际提取结果反查（FakeLLM 拿到 prompt 前候选已生成）
        captured = {}
        real_extract = None

        from app.services import resegment as rs
        real_extract = rs.extract_heading_candidates
        cands = real_extract(long_text)
        idx_b = next(i for i, c in enumerate(cands) if c.offset == off_b)
        processor._llm = FakeLLM([json.dumps([{"cand": idx_b, "title": "乙部分", "level": 1}])])

        pack = await processor.analyze_book(str(f), "b1")

        assert pack["resegmented"] is True
        assert pack["source"] == "ai_resegmented"
        assert pack["result"].total_chapters == 2
        assert processor.collection.count() == 0
        # 正文未经 AI：两章拼接应覆盖原文主体
        joined = "".join(c.content for c in pack["result"].chapters)
        assert "乙段正文内容若干" in joined and "甲段正文内容若干" in joined

    @pytest.mark.asyncio(loop_scope="function")
    async def test_resegment_failure_keeps_rule_split(self, processor, tmp_path, monkeypatch):
        """AI 两次全失败 → 保留规则切分结果，resegmented=False"""
        long_text = "标题行\n\n" + "正文内容若干正文内容若干。" * 4000
        f = tmp_path / "fail.txt"
        f.write_text(long_text, encoding="utf-8")

        async def fake_detect(t):
            return []
        monkeypatch.setattr(processor, "detect_toc_by_ai", fake_detect)
        from app.models.book_models import Chapter as _Ch
        swallow = [
            _Ch(chapter_id="s0", book_id="", title="整本书", content=long_text,
                word_count=len(long_text), chapter_index=0)]
        monkeypatch.setattr(processor, "split_by_toc", lambda ft, toc: list(swallow))
        processor._llm = FakeLLM(["坏", "更坏"])

        pack = await processor.analyze_book(str(f), "b1")

        assert pack["resegmented"] is False
        assert pack["result"].total_chapters == 1
        assert not pack["qc"].auto_commit  # 依然可疑 → 进人工核对
