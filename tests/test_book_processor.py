"""
pytest 测试套件 — 智能读书助手核心模块

运行方式：
  PYTHONPATH=backend pytest tests/ -v
"""

import pytest
import asyncio
import sys
import os
from pathlib import Path

# 确保 backend 在路径中
_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.services.book_processor import BookProcessor
from app.models.book_models import Chapter, TocItem

# 配置 pytest-asyncio
pytest_plugins = ('pytest_asyncio',)


class TestBookProcessor:
    """书籍处理器单元测试"""

    @pytest.fixture
    def processor(self, tmp_path):
        """创建测试用 BookProcessor 实例（使用临时目录）"""
        return BookProcessor(persist_directory=str(tmp_path / "chroma_test"))

    # ── 文本提取 ──────────────────────────────────────────────

    def test_extract_text_from_txt(self, processor, tmp_path):
        """TXT 文件提取"""
        book_file = tmp_path / "test.txt"
        book_file.write_text("第一章 引言\n\n这是第一章的内容。\n\n第二章 正文\n\n这是第二章的内容。", encoding="utf-8")

        text, metadata = processor.extract_text(str(book_file), "test_book")

        assert len(text) > 0
        assert metadata["format"] == "TXT"
        assert metadata["title"] == "test"

    def test_extract_text_unsupported_format(self, processor, tmp_path):
        """不支持的格式抛出异常"""
        bad_file = tmp_path / "test.jpg"
        bad_file.write_text("not a real file")

        with pytest.raises(ValueError, match="不支持的文件格式"):
            processor.extract_text(str(bad_file), "bad_book")

    # ── 目录识别（正则降级方案） ─────────────────────────────────

    def test_fallback_toc_detection_numbered_chapters(self, processor):
        """正则匹配：编号章节（标题必须在行末）"""
        text = """第一章 引言
本章介绍研究背景。

1.1 研究背景
深度学习近年来发展迅速。

第二章 文献综述
本章回顾相关工作。
"""
        toc_items = processor._fallback_toc_detection(text)

        assert len(toc_items) >= 2
        titles = [item.title for item in toc_items]
        assert any("第一章" in t for t in titles)
        assert any("第二章" in t for t in titles)

    def test_fallback_toc_detection_english_chapters(self, processor):
        """正则匹配：英文章节（标题必须在行末）"""
        text = """Chapter 1
This chapter covers the basics.

Chapter 2
This chapter reviews prior work.
"""
        toc_items = processor._fallback_toc_detection(text)

        assert len(toc_items) >= 2
        titles = [item.title for item in toc_items]
        assert any("Chapter 1" in t for t in titles)
        assert any("Chapter 2" in t for t in titles)

    def test_fallback_toc_detection_no_chapters(self, processor):
        """正则匹配：正文无章节标题"""
        text = "这是普通正文，没有任何章节结构。"
        toc_items = processor._fallback_toc_detection(text)

        assert isinstance(toc_items, list)

    # ── 章节切分 ──────────────────────────────────────────────

    def test_split_by_toc_with_items(self, processor):
        """根据目录切分章节（标题在行末，内容在后续行）"""
        filler = "这一部分包含大量正文内容，用于说明研究方法与背景知识等主题。字数必须明显超过切分引擎对短碎片的噪声过滤阈值，以保证章节不会被误丢弃。"
        text = f"""第一章 引言
{filler}

第二章 文献综述
{filler}{filler}

第三章 研究方法
{filler}{filler}{filler}
"""
        toc_items = [
            TocItem(title="第一章 引言", level=1, pattern="第一章 引言"),
            TocItem(title="第二章 文献综述", level=1, pattern="第二章 文献综述"),
            TocItem(title="第三章 研究方法", level=1, pattern="第三章 研究方法"),
        ]

        chapters = processor.split_by_toc(text, toc_items)

        assert len(chapters) >= 2
        assert all(isinstance(ch, Chapter) for ch in chapters)
        assert chapters[0].title == "第一章 引言"

    def test_split_by_toc_empty_toc(self, processor):
        """空目录时降级为段落切分"""
        text = "这是一段很长的正文" * 200
        chapters = processor.split_by_toc(text, [])

        assert len(chapters) >= 1
        assert all(isinstance(ch, Chapter) for ch in chapters)

    def test_split_by_toc_preserves_chapter_content(self, processor):
        """切分后章节内容完整"""
        filler = "这里的内容必须足够长，才能通过切分引擎对碎片章节的噪声过滤，否则整章会被当成非正文噪声而丢弃掉，这是符合真实书籍场景的设计。"
        text = f"""第一章 引言
{filler}

第二章 正文
{filler}{filler}
"""
        toc_items = [
            TocItem(title="第一章 引言", level=1, pattern="第一章 引言"),
            TocItem(title="第二章 正文", level=1, pattern="第二章 正文"),
        ]

        chapters = processor.split_by_toc(text, toc_items)

        # 验证两个章节都有内容
        assert len(chapters) == 2
        assert chapters[0].word_count > 0
        assert chapters[1].word_count > 0
        # 验证内容不丢失
        assert len(chapters[0].content) > 5
        assert len(chapters[1].content) > 5

    # ── ChromaDB 存储与检索 ────────────────────────────────────

    @pytest.mark.asyncio(loop_scope="function")
    async def test_store_and_search_chapters(self, processor, tmp_path):
        """存储章节后能检索回来"""
        chapters = [
            Chapter(
                chapter_id="ch1",
                book_id="test_book",
                title="第一章 引言",
                content="这是第一章的内容，讨论了人工智能的基本概念。",
                word_count=20,
                chapter_index=0,
                start_position=0,
                end_position=50
            ),
            Chapter(
                chapter_id="ch2",
                book_id="test_book",
                title="第二章 深度学习",
                content="这是第二章的内容，讨论了深度学习的基本原理。",
                word_count=20,
                chapter_index=1,
                start_position=51,
                end_position=100
            ),
        ]

        await processor.store_chapters_to_chroma("test_book", chapters, book_title="测试书")

        # 检索
        results = await processor.search_chapters(
            query="人工智能",
            book_ids=["test_book"],
            n_results=2
        )

        assert len(results) >= 1
        assert results[0].title == "第一章 引言"

    @pytest.mark.asyncio(loop_scope="function")
    async def test_search_chapters_filter_by_book(self, processor, tmp_path):
        """检索能按书ID过滤"""
        chapters_book1 = [
            Chapter(
                chapter_id="b1ch1",
                book_id="book1",
                title="Book1 Chapter",
                content="This is about Python programming.",
                word_count=5,
                chapter_index=0,
                start_position=0,
                end_position=30
            ),
        ]
        chapters_book2 = [
            Chapter(
                chapter_id="b2ch1",
                book_id="book2",
                title="Book2 Chapter",
                content="This is about JavaScript programming.",
                word_count=5,
                chapter_index=0,
                start_position=0,
                end_position=35
            ),
        ]

        await processor.store_chapters_to_chroma("book1", chapters_book1, book_title="Book1")
        await processor.store_chapters_to_chroma("book2", chapters_book2, book_title="Book2")

        # 只检索 book1
        results = await processor.search_chapters(
            query="programming",
            book_ids=["book1"],
            n_results=5
        )

        assert all(r.book_id == "book1" for r in results)

    @pytest.mark.asyncio(loop_scope="function")
    async def test_get_chapter_by_id(self, processor, tmp_path):
        """根据 ID 获取章节"""
        chapter = Chapter(
            chapter_id="unique_chapter_id",
            book_id="test_book",
            title="唯一章节",
            content="这是唯一章节的内容。",
            word_count=10,
            chapter_index=0,
            start_position=0,
            end_position=30
        )

        await processor.store_chapters_to_chroma("test_book", [chapter], book_title="测试")

        retrieved = processor.get_chapter_by_id("unique_chapter_id")

        assert retrieved is not None
        assert retrieved.chapter_id == "unique_chapter_id"
        assert retrieved.title == "唯一章节"

    # ── 置信度打分 ──────────────────────────────────────────────

    def test_heading_score_exact_match(self, processor):
        """精确行首锚定得高分"""
        text = "第一章 引言\n\n这是正文内容。"
        score = BookProcessor._heading_score(text, 0, 7, match_priority=0)
        assert score > 0.3  # 精确锚定应该有基本分数

    def test_heading_score_paragraph_context(self, processor):
        """行末有句末标点扣分"""
        text = "这是第一章 引言。"  # 以句号结尾，通常不是标题
        score = BookProcessor._heading_score(text, 0, 10, match_priority=0)
        assert isinstance(score, float)

    # ── TXT 编码探测 ────────────────────────────────────────

    def test_read_txt_gbk_encoded(self, processor, tmp_path):
        """GBK 编码的中文 TXT 能正确读取（旧实现直接 utf-8 解码会崩溃）"""
        content = "第一章 测试\n\n这是一段用GBK编码的中文小说正文，包含汉字与标点，应该被完整识别。\n\n第二章 结束\n\n又是一段足够长的正文内容，验证多章节都能被读取到没有乱码。"
        gbk_file = tmp_path / "gbk_book.txt"
        gbk_file.write_bytes(content.encode("gbk"))

        text, meta = processor.extract_text(str(gbk_file), "gbk_test")

        assert "GBK编码" in text
        assert "正文内容" in text
        assert "\ufffd" not in text  # 不应有替换符乱码

    def test_read_txt_utf8_with_bom(self, processor, tmp_path):
        """带 BOM 的 UTF-8 文件不应把 BOM 留在正文里"""
        f = tmp_path / "bom.txt"
        f.write_bytes("第一章 标题\n\n正文内容要超过五十个字符才能通过切分引擎的噪声过滤机制，这里需要凑够足够的字数才行。".encode("utf-8-sig"))

        text, _ = processor.extract_text(str(f), "bom_test")

        assert not text.startswith("\ufeff")
        assert "正文内容" in text

    def test_read_txt_plain_utf8(self, processor, tmp_path):
        """普通 UTF-8 仍走首选路径，不受编码探测干扰"""
        f = tmp_path / "utf8.txt"
        f.write_text("第一章 标题\n\n这段UTF-8正文同样需要超过五十个字符来通过切分引擎的短章节噪声过滤，因此这里多写一些内容来凑够长度要求。", encoding="utf-8")

        text, _ = processor.extract_text(str(f), "utf8_test")

        assert "这段UTF-8正文" in text

    # ── EPUB 原生目录 ───────────────────────────────────────

    def _make_epub(self, tmp_path, with_toc: bool):
        """构造一本带/不带原生目录的测试 EPUB"""
        from ebooklib import epub

        book = epub.EpubBook()
        book.set_identifier("test-book")
        book.set_title("测试书目")
        book.set_language("zh")
        book.add_author("测试作者")

        chapters = []
        for i, name in enumerate(["第一章 起点", "第二章 途中", "第三章 终点"]):
            ch = epub.EpubHtml(
                title=name, file_name=f"chap{i+1}.xhtml", lang="zh"
            )
            body = f"<h1>{name}</h1>" + "".join(
                f"<p>第{i+1}章的正文内容，这里需要足够多的汉字来保证章节长度超过切分引擎的噪声过滤阈值，多写几句以增加总字数。第{i}句。</p>"
                for _ in range(3)
            )
            ch.set_content(f"<html><body>{body}</body></html>")
            book.add_item(ch)
            chapters.append(ch)

        book.add_item(epub.EpubNcx())
        book.add_item(epub.EpubNav())
        if with_toc:
            book.toc = [epub.Link(c.file_name, c.title, c.title) for c in chapters]
            book.spine = ["nav"] + chapters
        else:
            book.spine = ["nav"] + chapters

        epub.write_epub(str(tmp_path / ("toc.epub" if with_toc else "notoc.epub")), book)
        return str(tmp_path / ("toc.epub" if with_toc else "notoc.epub"))

    def test_epub_native_toc_chapters(self, processor, tmp_path):
        """带原生目录的 EPUB：按 TOC 精确切分，不调用 AI"""
        path = self._make_epub(tmp_path, with_toc=True)

        result = processor._extract_epub_native(path)

        assert result is not None
        metadata, chapters, toc_items = result
        assert metadata["title"] == "测试书目"
        titles = [c.title for c in chapters]
        assert "第一章 起点" in titles
        assert "第三章 终点" in titles
        assert len([c for c in chapters if c.title.startswith("第")]) == 3

    def test_epub_without_toc_returns_none(self, processor, tmp_path):
        """无原生目录的 EPUB：返回 None，由上层降级到 AI/正则链路"""
        path = self._make_epub(tmp_path, with_toc=False)

        assert processor._extract_epub_native(path) is None
