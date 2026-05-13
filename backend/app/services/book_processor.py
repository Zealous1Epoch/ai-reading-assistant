"""
书籍处理器 - 智能章节切分与向量化存储
支持 PDF 和 EPUB 格式，使用 AI 辅助识别目录结构
"""

import re
import json
import uuid
import os
import io
from typing import List, Optional, Tuple
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import fitz  # PyMuPDF
from ebooklib import epub
from langchain_openai import ChatOpenAI
from langchain.schema import HumanMessage, SystemMessage
from PIL import Image

from app.config import get_settings
from app.models.book_models import Chapter, TocItem, BookAnalysisResult, ChapterSearchResult

# ChromaDB
import chromadb
from chromadb.config import Settings as ChromaSettings

# OCR（扫描版PDF降级方案）
try:
    import pytesseract
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

settings = get_settings()


class BookProcessor:
    """书籍处理器 - 智能章节切分"""

    def __init__(self, persist_directory: str = "./data/chroma_db"):
        self._llm = None  # 延迟初始化
        self.persist_directory = persist_directory
        self._ocr_progress = {}  # {book_id: {"current": N, "total": M}}
        os.makedirs(persist_directory, exist_ok=True)

        # 初始化 ChromaDB
        self.chroma_client = chromadb.PersistentClient(path=persist_directory)
        self.collection = self.chroma_client.get_or_create_collection(
            name="book_chapters",
            metadata={"description": "书籍章节向量化存储"}
        )

    @property
    def llm(self):
        """延迟初始化LLM"""
        if self._llm is None:
            if not settings.deepseek_api_key:
                raise ValueError("请配置DEEPSEEK_API_KEY环境变量")
            self._llm = ChatOpenAI(
                model=settings.deepseek_model,
                openai_api_key=settings.deepseek_api_key,
                openai_api_base=settings.deepseek_base_url,
                temperature=0.1,
            )
        return self._llm

    def extract_text_from_pdf(self, file_path: str, book_id: str = "") -> Tuple[str, dict]:
        """从PDF提取文本（自动降级到OCR处理扫描版PDF）"""
        doc = fitz.open(file_path)
        full_text = ""
        metadata = {
            "title": doc.metadata.get("title") or Path(file_path).stem,
            "author": doc.metadata.get("author") or "未知作者",
            "pages": len(doc),
            "format": "PDF"
        }

        for page_num, page in enumerate(doc):
            text = page.get_text()
            full_text += f"\n[PAGE {page_num + 1}]\n{text}"

        # 检测是否为扫描版PDF：平均每页文字少于20字符
        total_pages = len(doc)
        text_chars = len(full_text.strip())
        needs_ocr = total_pages > 0 and (text_chars // total_pages) < 20

        if needs_ocr and HAS_OCR:
            print(f"检测到扫描版PDF（{total_pages}页，仅{text_chars}文字），启动OCR...")
            ocr_text = self._ocr_pdf(doc, book_id)
            if len(ocr_text) > text_chars:
                full_text = ocr_text
                print(f"OCR完成，提取到{len(ocr_text)}文字")
            if book_id in self._ocr_progress:
                del self._ocr_progress[book_id]
        elif needs_ocr and not HAS_OCR:
            print(f"警告：检测到扫描版PDF（{total_pages}页，仅{text_chars}文字），但pytesseract未安装，OCR被跳过。请安装: pip install pytesseract")

        doc.close()
        return full_text, metadata

    def _ocr_pdf(self, doc: fitz.Document, book_id: str = "") -> str:
        """对扫描版PDF执行OCR识别（并行处理，使用本地Tesseract）"""
        import threading
        total = len(doc)
        result = [""] * total
        done = 0
        _lock = threading.Lock()  # fitz.Document非线程安全，需加锁
        self._ocr_progress[book_id] = {"current": 0, "total": total}

        def ocr_page(page_num: int) -> tuple:
            # 渲染阶段加锁（fitz非线程安全），OCR阶段不加锁
            with _lock:
                page = doc[page_num]
                pix = page.get_pixmap(dpi=150)
                img = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
            text = pytesseract.image_to_string(img, lang='chi_sim+eng')
            return page_num, text.strip()

        max_workers = min(4, total)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(ocr_page, i) for i in range(total)]
            for f in as_completed(futures):
                page_num, text = f.result()
                result[page_num] = f"\n[PAGE {page_num + 1}]\n{text}"
                done += 1
                self._ocr_progress[book_id] = {"current": done, "total": total}
                if done % 20 == 0 or done == total:
                    print(f"  OCR进度: {done}/{total}页")

        return "\n\n".join(result)

    def extract_text_from_epub(self, file_path: str) -> Tuple[str, dict]:
        """从EPUB提取文本和元数据（按spine阅读顺序）"""
        book = epub.read_epub(file_path)
        full_text = ""

        metadata = {
            "title": book.get_metadata('DC', 'title')[0][0] if book.get_metadata('DC', 'title') else Path(file_path).stem,
            "author": book.get_metadata('DC', 'creator')[0][0] if book.get_metadata('DC', 'creator') else "未知作者",
            "format": "EPUB"
        }

        # 建立 id -> item 索引
        items_by_id = {item.get_id(): item for item in book.get_items()}

        # 按 spine 顺序遍历（spine 定义阅读顺序）
        for idref, _ in book.spine:
            item = items_by_id.get(idref)
            if item is None or item.get_type() != 9:  # 跳过非文档项
                continue

            content = item.get_content().decode('utf-8', errors='ignore')
            # 保留段落结构：块级标签替换为换行
            text = re.sub(r'</?(?:p|div|h[1-6]|li|ul|ol|tr|td|th|br|section|article|blockquote|dl|dt|dd)[^>]*>', '\n', content, flags=re.IGNORECASE)
            # 剩余行内标签替换为空格
            text = re.sub(r'<[^>]+>', ' ', text)
            # 折叠空白
            text = re.sub(r'[ \t]+', ' ', text)
            text = re.sub(r'\n{3,}', '\n\n', text)
            text = text.strip()
            if text:
                full_text += text + "\n\n"

        return full_text, metadata

    def extract_text(self, file_path: str, book_id: str = "") -> Tuple[str, dict]:
        """自动检测格式并提取文本"""
        suffix = Path(file_path).suffix.lower()

        if suffix == ".pdf":
            return self.extract_text_from_pdf(file_path, book_id)
        elif suffix == ".epub":
            return self.extract_text_from_epub(file_path)
        elif suffix == ".txt":
            with open(file_path, "r", encoding="utf-8") as f:
                text = f.read()
            return text, {"title": Path(file_path).stem, "author": "未知作者", "format": "TXT"}
        else:
            raise ValueError(f"不支持的文件格式: {suffix}")

    async def detect_toc_by_ai(self, text_sample: str) -> List[TocItem]:
        """使用AI识别目录结构"""

        system_prompt = """你是一个专业的书籍结构分析助手。你的任务是分析给定的书籍文本，识别出目录结构。

请仔细分析文本中的以下线索：
1. 明确的"目录"、"目次"等章节
2. 章节标题模式（如"第一章"、"Chapter 1"、"第1节"等）
3. 标题的格式特征（如居中、加粗、字号变化等在文本中的痕迹）
4. 页码标记

输出要求：
- 返回JSON数组格式
- 每个目录项包含：title（章节标题）、level（层级，1为一级章节，2为二级小节）、pattern（用于匹配的文本模式）
- 如果没有明确的目录，根据章节标题模式推断

示例输出：
[
    {"title": "第一章 引言", "level": 1, "pattern": "第一章 引言"},
    {"title": "1.1 研究背景", "level": 2, "pattern": "1.1 研究背景"}
]"""

        user_prompt = f"""请分析以下书籍文本片段，识别目录结构：

{text_sample}

请直接输出JSON数组，不要有其他说明文字。"""

        try:
            response = await self.llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt)
            ])

            # 解析AI返回的JSON
            content = response.content
            # 尝试提取JSON部分
            json_match = re.search(r'\[.*\]', content, re.DOTALL)
            if json_match:
                toc_data = json.loads(json_match.group())
                return [TocItem(
                    title=item.get("title", ""),
                    level=item.get("level", 1),
                    pattern=item.get("pattern", item.get("title", ""))
                ) for item in toc_data]
        except Exception as e:
            print(f"AI识别目录失败: {e}")

        # AI失败返回空，由上层走正则全文扫描
        return []

    def _fallback_toc_detection(self, text: str) -> List[TocItem]:
        """降级方案：正则匹配章节（零成本，扫描全文）"""

        patterns = [
            # 行首匹配 + 行尾终止：确保匹配的是完整标题行，而非正文中的引用
            r'(?m)^\s*第[一二三四五六七八九十百千万零\d]+[章回节卷](?:\s*\S[^\n]{0,20})?$',
            r'(?m)^\s*Chapter\s+\d+(?::?\s*\S[^\n]{0,20})?$',
            r'(?m)^\s*Part\s+[一二三四五六七八九十\dIVXLCDM]+(?::?\s*\S[^\n]{0,20})?$',
            r'(?m)^\s*Section\s*\d+(?::?\s*\S[^\n]{0,20})?$',
            r'(?m)^\s*\d+\.\d+\s+\S[^\n]{0,20}$',
            # 无编号的章节标题：序/前言/附录等（排除句末标点以防匹配到正文句子）
            r'(?m)^\s*(?:序言?|导言|引言|前言|绪论|附录[：:]?\S*|致谢|注释|跋|后记|参考文献|参考书目)[^\n。？！]{0,20}$',
        ]

        # 第一遍：收集所有匹配
        raw_matches = []
        seen_texts = set()

        for pattern in patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                title = match.group().strip()
                if not title or len(title) > 40 or title in seen_texts:
                    continue
                seen_texts.add(title)
                raw_matches.append((match.start(), title))

        # 按位置排序
        raw_matches.sort(key=lambda x: x[0])

        # 去重：相同章节号只保留正文位置（靠后的那个）
        # 目录区（TOC）的标题位置靠前，正文标题位置靠后
        chapter_groups = {}
        for pos, title in raw_matches:
            # 提取章节号作为分组key（如"第1章"、"引言"）
            m = re.search(r'第[一二三四五六七八九十百千万零\d]+[章回节卷]', title)
            if m:
                key = m.group()
            else:
                # 非编号标题，取前4个有效中文字作key（去除标点、序号、空白）
                key = re.sub(r'[\s\d.　。，、：；!！?？、]+', '', title)[:4]
            # 保留最靠后的位置（正文标题通常出现得更晚）
            if key not in chapter_groups or pos > chapter_groups[key][0]:
                chapter_groups[key] = (pos, title)

        # 生成TocItem，按位置排序
        sorted_items = sorted(chapter_groups.values(), key=lambda x: x[0])
        toc_items = []
        for pos, title in sorted_items:
            # 清理标题中的多余换行
            clean_title = re.sub(r'\s+', ' ', title).strip()
            toc_items.append(TocItem(
                title=clean_title,
                level=1 if "章" in clean_title or "Chapter" in clean_title.lower() else 2,
                pattern=clean_title
            ))

        return toc_items[:30]

    def split_by_toc(self, full_text: str, toc_items: List[TocItem]) -> List[Chapter]:
        """根据目录切分章节"""
        if not toc_items:
            # 没有目录，按段落平均切分
            return self._split_by_paragraphs(full_text)

        chapters = []
        # 构建章节定位点
        positions = []
        for item in toc_items:
            if item.pattern:
                pattern = item.pattern.strip()
                # 使用行首匹配，避免短关键词（如"序言"）匹配到正文句子
                # 匹配模式：行首 + 标题 + 至多20个非句末标点字符 + 行尾
                heading_regex = rf'(?m)^\s*{re.escape(pattern)}[^\n。？！]{{0,20}}$'
                matches = list(re.finditer(heading_regex, full_text))
                # 取最后一个匹配（优先取正文位置而非目录区）
                match = matches[-1] if matches else None
                if not match:
                    # 降级：子串匹配
                    matches = list(re.finditer(re.escape(pattern), full_text))
                    match = matches[-1] if matches else None
                if not match:
                    # 降级：宽松匹配（允许标题前后有空白）
                    pattern_regex = r'\b' + re.escape(pattern[:20]) + r'.*?(?=\n|$)'
                    matches = list(re.finditer(pattern_regex, full_text))
                    match = matches[-1] if matches else None

                if match:
                    positions.append((match.start(), item))

        # 按位置排序并去重
        positions.sort(key=lambda x: x[0])

        # 正文区域判断：
        # matches[-1]已经处理了"目录区vs正文"的歧义（同一标题在目录区和正文各出现一次时取正文位置），
        # 所以无需跳过开头的密集集群。直接使用所有匹配位置作为章节边界。
        body_positions = positions

        # 如果正文第一个章节不是从位置0开始，插入一个前置章节承接首页/目录等内容
        if body_positions and body_positions[0][0] > 0:
            body_positions.insert(0, (0, None))

        # 切分章节
        for i, (start_pos, toc_item) in enumerate(body_positions):
            # 章节结束位置：下一个章节开始，或文本结束
            if i + 1 < len(body_positions):
                end_pos = body_positions[i + 1][0]
            else:
                end_pos = len(full_text)

            content = full_text[start_pos:end_pos].strip()
            word_count = len(content)

            if word_count > 50:  # 忽略太短的章节
                title = toc_item.title if toc_item else "序言/引言"
                chapters.append(Chapter(
                    chapter_id=str(uuid.uuid4()),
                    book_id="",  # 后续填充
                    title=title,
                    content=content,
                    word_count=word_count,
                    chapter_index=len(chapters),  # 使用实际索引
                    start_position=start_pos,
                    end_position=end_pos
                ))

        return chapters

    def _split_by_paragraphs(self, text: str, min_words: int = 2000) -> List[Chapter]:
        """按段落平均切分（降级方案）"""
        paragraphs = text.split('\n\n')
        chapters = []
        current_content = ""
        chapter_index = 0

        for para in paragraphs:
            current_content += para + "\n\n"

            if len(current_content) >= min_words:
                chapters.append(Chapter(
                    chapter_id=str(uuid.uuid4()),
                    book_id="",
                    title=f"第{chapter_index + 1}部分",
                    content=current_content.strip(),
                    word_count=len(current_content),
                    chapter_index=chapter_index
                ))
                current_content = ""
                chapter_index += 1

        # 处理剩余内容
        if current_content.strip():
            chapters.append(Chapter(
                chapter_id=str(uuid.uuid4()),
                book_id="",
                title=f"第{chapter_index + 1}部分",
                content=current_content.strip(),
                word_count=len(current_content),
                chapter_index=chapter_index
            ))

        return chapters

    async def process_book(self, file_path: str, book_id: str) -> BookAnalysisResult:
        """处理书籍：提取文本、识别目录、切分章节、向量化存储"""

        # 1. 提取文本
        full_text, metadata = self.extract_text(file_path, book_id)

        # 2. 先用AI识别目录（仅看前5000字，省成本）
        toc_items = await self.detect_toc_by_ai(full_text[:5000])

        # 3. AI失败时的保底方案：正则扫描全文找章节（零成本）
        if not toc_items:
            toc_items = self._fallback_toc_detection(full_text)

        # 4. 根据目录切分章节
        chapters = self.split_by_toc(full_text, toc_items)

        # 4. 填充book_id
        for chapter in chapters:
            chapter.book_id = book_id

        # 5. 存储到ChromaDB
        await self.store_chapters_to_chroma(book_id, chapters, book_title=metadata.get("title", ""))

        # 6. 返回分析结果
        total_words = sum(ch.word_count for ch in chapters)

        return BookAnalysisResult(
            book_id=book_id,
            title=metadata.get("title", Path(file_path).stem),
            author=metadata.get("author"),
            total_chapters=len(chapters),
            total_words=total_words,
            chapters=chapters,
            toc=toc_items,
            file_format=metadata.get("format", "Unknown")
        )

    def _clean_chapter_content(self, text: str) -> str:
        """清洗章节内容：移除PDF噪声、乱码、CIP数据"""
        # 1. 移除 [PAGE X] 标记
        text = re.sub(r'\n?\[PAGE\s*\d+\]\n?', '\n', text)

        # 2. 逐行过滤乱码（非正常文本行占比过高则丢弃）
        clean_lines = []
        for line in text.split('\n'):
            stripped = line.strip()
            if not stripped:
                clean_lines.append('')
                continue
            # 跳过纯数字/符号行
            if re.match(r'^[\d\s\.\,\-\+\=]+$', stripped):
                continue
            # 跳过含大量乱码字符的行（非中英文、非标点的字符占比 > 40%）
            valid_chars = sum(1 for c in stripped if c.isalpha() or c.isdigit() or
                              '一' <= c <= '鿿' or '　' <= c <= '〿' or
                              '＀' <= c <= '￯' or c in ' .,;:!?()（）[]【】《》、，。；：？！—…·\t')
            if len(stripped) > 0 and valid_chars / len(stripped) < 0.4:
                continue
            clean_lines.append(stripped)

        text = '\n'.join(clean_lines)

        # 3. 移除 CIP 数据块（图书在版编目）
        text = re.sub(r'图书在版编目.*?ISBN[^\n]*', '', text, flags=re.DOTALL)
        text = re.sub(r'CIP.*?核字[^\n]*', '', text)

        # 4. 规范化空白
        text = re.sub(r'\n{4,}', '\n\n\n', text)
        text = re.sub(r' {3,}', '  ', text)

        # 5. 移除首尾明显的非正文行（如纯英文标题行在中文书中）
        lines = text.strip().split('\n')
        if lines and len(lines[0].strip()) < 5 and not any('一' <= c <= '鿿' for c in lines[0]):
            lines = lines[1:]

        return '\n'.join(lines).strip()

    async def store_chapters_to_chroma(self, book_id: str, chapters: List[Chapter], book_title: str = ""):
        """将章节存储到ChromaDB"""

        if not chapters:
            return

        # 批量添加
        ids = []
        documents = []
        metadatas = []

        for chapter in chapters:
            cleaned_content = self._clean_chapter_content(chapter.content)
            ids.append(chapter.chapter_id)
            documents.append(cleaned_content)
            metadatas.append({
                "book_id": book_id,
                "book_title": book_title,
                "chapter_id": chapter.chapter_id,
                "title": chapter.title,
                "chapter_index": chapter.chapter_index,
                "word_count": chapter.word_count
            })

        # 添加到集合
        self.collection.add(
            ids=ids,
            documents=documents,
            metadatas=metadatas
        )

    async def search_chapters(self, query: str, book_ids: Optional[List[str]] = None, n_results: int = 5) -> List[ChapterSearchResult]:
        """搜索章节内容（支持多本书过滤）"""

        where_filter = None
        if book_ids:
            if len(book_ids) == 1:
                where_filter = {"book_id": book_ids[0]}
            else:
                where_filter = {"book_id": {"$in": book_ids}}

        results = self.collection.query(
            query_texts=[query],
            n_results=n_results,
            where=where_filter,
            include=["documents", "metadatas", "distances"]
        )

        search_results = []
        if results['ids'] and results['ids'][0]:
            for i, doc_id in enumerate(results['ids'][0]):
                content = results['documents'][0][i]
                metadata = results['metadatas'][0][i]
                distance = results['distances'][0][i]

                # 生成内容片段
                snippet = content[:300] + "..." if len(content) > 300 else content

                search_results.append(ChapterSearchResult(
                    chapter_id=metadata.get('chapter_id', doc_id),
                    book_id=metadata.get('book_id', ''),
                    book_title=metadata.get('book_title', ''),
                    title=metadata.get('title', ''),
                    content_snippet=snippet,
                    chapter_index=metadata.get('chapter_index', 0),
                    relevance_score=1 - distance  # 转换为相似度
                ))

        return search_results

    def get_chapter_by_id(self, chapter_id: str) -> Optional[Chapter]:
        """根据ID获取章节"""
        results = self.collection.get(
            ids=[chapter_id],
            include=["documents", "metadatas"]
        )

        if results['ids']:
            content = results['documents'][0]
            metadata = results['metadatas'][0]

            return Chapter(
                chapter_id=chapter_id,
                book_id=metadata.get('book_id', ''),
                title=metadata.get('title', ''),
                content=content,
                word_count=len(content),
                chapter_index=metadata.get('chapter_index', 0)
            )

        return None

    def delete_book_chapters(self, book_id: str):
        """删除指定书籍的所有章节"""
        # 先查询该书籍的所有章节ID
        results = self.collection.get(
            where={"book_id": book_id}
        )

        if results['ids']:
            self.collection.delete(ids=results['ids'])


# 单例
book_processor = BookProcessor()
