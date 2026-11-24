"""质检规则引擎单元测试（R1~R10 逐条正反例，零 LLM 零 IO）"""

import pytest

from app.models.book_models import Chapter
from app.services.quality_check import run_quality_check


def mk_chapter(title="第X章 测试", content="正文" * 100, idx=0, cid=None, **kw):
    return Chapter(
        chapter_id=cid or f"ch-{idx}",
        book_id="book-1",
        title=title,
        content=content,
        word_count=len(content),
        chapter_index=idx,
        **kw,
    )


def chapters_for(total_words_each, n, prefix="第", suffix="章"):
    """生成 n 个等长章节"""
    cn = "一二三四五六七八九十"
    return [
        mk_chapter(
            title=f"{prefix}{cn[i] if i < 10 else str(i + 1)}{suffix} 标题{i}",
            content="字" * total_words_each,
            idx=i,
        )
        for i in range(n)
    ]


class TestR1SingleChapterRatio:
    def test_triggers_on_dominant_chapter(self):
        """铁证待判形态：一章占 97%"""
        chapters = [mk_chapter("引 言", "字" * 350_000, 0),
                    mk_chapter("前言", "字" * 5_000, 1),
                    mk_chapter("后记", "字" * 5_000, 2)]
        report = run_quality_check(chapters)
        assert any(it.rule == "R1" and it.level == "warning" for it in report.items)
        assert not report.auto_commit

    def test_not_trigger_when_balanced(self):
        chapters = chapters_for(50_000, 10)
        report = run_quality_check(chapters)
        assert not any(it.rule == "R1" for it in report.items)

    def test_not_trigger_when_many_chapters(self):
        """章数 > 10 时单章稍大属正常（大章节书）"""
        big = mk_chapter("第一章 大章", "字" * 100_000, 0)
        rest = [mk_chapter(f"第{i+2}章", "字" * 5_000, i + 1) for i in range(12)]
        report = run_quality_check([big] + rest)
        assert not any(it.rule == "R1" for it in report.items)


class TestR2SparseBook:
    def test_triggers(self):
        chapters = chapters_for(20_000, 7)  # 14万字仅7章
        report = run_quality_check(chapters)
        assert any(it.rule == "R2" for it in report.items)

    def test_not_trigger_short_book(self):
        chapters = chapters_for(2_000, 7)  # 1.4万字小书7章正常
        report = run_quality_check(chapters)
        assert not any(it.rule == "R2" for it in report.items)


class TestR3FrontMatter:
    def test_title_hit(self):
        chapters = [mk_chapter("版权页", "出版社信息若干", 0)] + chapters_for(20_000, 8)
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R3"]
        assert hits and hits[0].chapter_ids == ["ch-0"]

    def test_body_hit_cip(self):
        body = "图书在版编目（CIP）数据\n某某书 / 某某著\nISBN 978-7-1234-5678-9\n出版：某某出版社"
        chapters = [mk_chapter("前置内容", body, 0)] + chapters_for(20_000, 8)
        report = run_quality_check(chapters)
        assert any(it.rule == "R3" for it in report.items)

    def test_not_trigger_in_body_middle(self):
        """版权特征章出现在第 4 章以后不判（前 3 章之外）"""
        odd = mk_chapter("第四章 出版考证", "图书在版编目 CIP数据 ISBN 978-7-1234-5678-9 讨论", idx=4)
        chapters = chapters_for(20_000, 3) + [odd] + chapters_for(20_000, 6, "第", "章")
        report = run_quality_check(chapters)
        assert not any(it.rule == "R3" for it in report.items)


class TestR4EmptyAfterClean:
    def test_triggers(self):
        ch = mk_chapter("序言/引言", "[PAGE 1]\n123\n456", 0)
        ch.cleaned_word_count = 0  # store 回填后的真口径
        chapters = [ch] + chapters_for(20_000, 8)
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R4"]
        assert hits and "ch-0" in hits[0].chapter_ids

    def test_skipped_when_cleaned_unknown(self):
        """旧数据 cleaned_word_count=None 时不误判 R4（回退口径只用于其他规则）"""
        ch = mk_chapter("序言/引言", "[PAGE 1]\n123", 0)
        chapters = [ch] + chapters_for(20_000, 8)
        report = run_quality_check(chapters)
        assert not any(it.rule == "R4" and "ch-0" in it.chapter_ids for it in report.items)


class TestR5ChapterPage:
    def test_info_level_not_blocking(self):
        chapters = [mk_chapter("第一章 让爱融入生活", "字" * 300, 0)] + chapters_for(20_000, 8)
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R5"]
        assert hits and hits[0].level == "info"
        assert report.auto_commit  # info 不拦自动入库

    def test_legit_short_front_matter_whitelisted(self):
        chapters = [mk_chapter("译序", "字" * 300, 0)] + chapters_for(20_000, 8)
        report = run_quality_check(chapters)
        assert not any(it.rule == "R5" for it in report.items)


class TestR6HierarchyFlatten:
    def test_triggers(self):
        """人生的抉择形态：无章号章夹在第X章与第X+1章之间"""
        chapters = [
            mk_chapter("第一章 让爱融入生活", "字" * 20_000, 0),
            mk_chapter("人生的抉择", "字" * 5_000, 1),
            mk_chapter("第二章 是什么蒙蔽了爱", "字" * 20_000, 2),
        ] + chapters_for(20_000, 5)
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R6"]
        assert hits and hits[0].level == "info" and "ch-1" in hits[0].chapter_ids

    def test_arabic_chapter_numbers(self):
        chapters = [
            mk_chapter("第1章 起", "字" * 20_000, 0),
            mk_chapter("插叙", "字" * 5_000, 1),
            mk_chapter("第2章 承", "字" * 20_000, 2),
        ]
        report = run_quality_check(chapters)
        assert any(it.rule == "R6" for it in report.items)

    def test_no_trigger_when_numbered(self):
        chapters = chapters_for(20_000, 4)  # 全部带章号
        report = run_quality_check(chapters)
        assert not any(it.rule == "R6" for it in report.items)


class TestR7Coverage:
    def test_triggers(self):
        chapters = chapters_for(3_000, 5)  # 清洗后共 1.5 万
        report = run_quality_check(chapters, full_text_chars=100_000)  # 全文 10 万
        assert any(it.rule == "R7" and it.level == "warning" for it in report.items)

    def test_not_trigger_good_coverage(self):
        chapters = chapters_for(20_000, 5)  # 10 万
        report = run_quality_check(chapters, full_text_chars=110_000)
        assert not any(it.rule == "R7" for it in report.items)

    def test_skipped_without_denominator(self):
        chapters = chapters_for(3_000, 5)
        report = run_quality_check(chapters, full_text_chars=None)
        assert not any(it.rule == "R7" for it in report.items)


class TestR8AnchorOrder:
    def test_triggers_blocking(self):
        chapters = [
            mk_chapter("第一章", "字" * 9_000, 0, start_position=5000),
            mk_chapter("第二章", "字" * 9_000, 1, start_position=1000),  # 倒挂
            mk_chapter("第三章", "字" * 9_000, 2, start_position=9000),
        ]
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R8"]
        assert hits and hits[0].level == "blocking"
        assert not report.auto_commit

    def test_not_trigger_without_positions(self):
        """EPUB 原生链路无 start_position：不判 R8 而非误判"""
        chapters = chapters_for(9_000, 3)
        report = run_quality_check(chapters)
        assert not any(it.rule == "R8" for it in report.items)


class TestR9Degenerate:
    def test_single_chapter_blocking(self):
        chapters = [mk_chapter("全书", "字" * 300_000, 0)]
        report = run_quality_check(chapters)
        assert any(it.rule == "R9" and it.level == "blocking" for it in report.items)
        assert not report.auto_commit

    def test_tiny_total_blocking(self):
        chapters = chapters_for(100, 3)
        report = run_quality_check(chapters)
        assert any(it.rule == "R9" for it in report.items)


class TestR10EpubSpineUtilization:
    def test_triggers(self):
        """铁证待判形态：23 个 spine 文档只有 7 个锚点"""
        chapters = chapters_for(50_000, 7)
        report = run_quality_check(
            chapters, source="epub_native",
            epub_spine_docs=23, epub_native_anchors=7,
        )
        assert any(it.rule == "R10" for it in report.items)

    def test_not_trigger_good_toc(self):
        chapters = chapters_for(50_000, 20)
        report = run_quality_check(
            chapters, source="epub_native",
            epub_spine_docs=22, epub_native_anchors=20,
        )
        assert not any(it.rule == "R10" for it in report.items)

    def test_not_trigger_generic_source(self):
        """非原生链路（AI/正则切分）不套 R10：分母语义不同"""
        chapters = chapters_for(50_000, 7)
        report = run_quality_check(
            chapters, source="generic",
            epub_spine_docs=23, epub_native_anchors=7,
        )
        assert not any(it.rule == "R10" for it in report.items)


class TestAutoCommitGate:
    def test_clean_book_auto_commits(self):
        """均衡书形态：12 章等长切分应全绿直通"""
        cn = "一二三四五六七八九十"
        chapters = []
        for i in range(12):
            num = cn[i] if i < 10 else str(i + 1)
            c = mk_chapter(f"第{num}章 标题", "字" * 8_000, i)
            c.cleaned_word_count = 8_000
            chapters.append(c)
        report = run_quality_check(chapters, full_text_chars=100_000)
        assert report.auto_commit, [it.msg for it in report.items if it.level != "info"]

    def test_warning_blocks_auto_commit(self):
        chapters = [mk_chapter("引 言", "字" * 350_000, 0), mk_chapter("后记", "字" * 5_000, 1)]
        report = run_quality_check(chapters)
        assert not report.auto_commit

    def test_info_only_still_auto_commits(self):
        chapters = [mk_chapter("第一章", "字" * 300, 0),
                    mk_chapter("第二章", "字" * 25_000, 1),
                    mk_chapter("第三章", "字" * 25_000, 2),
                    mk_chapter("第四章", "字" * 25_000, 3)]
        # 总 75,300 字 < 80k 不触 R2；单章占比 33% 不触 R1；只应有 R5 info
        report = run_quality_check(chapters, full_text_chars=76_000)
        assert [it.level for it in report.items] == ["info"], [it.msg for it in report.items]
        assert report.auto_commit
