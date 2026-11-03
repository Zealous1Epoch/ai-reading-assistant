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
from langchain_core.messages import HumanMessage, SystemMessage
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

    def __init__(self, persist_directory: str = None):
        self._llm = None  # 延迟初始化
        # 绝对锚定到 backend/data/chroma_db，与进程启动目录解耦
        self.persist_directory = persist_directory or os.path.join(
            settings.data_dir, "chroma_db"
        )
        self._ocr_progress = {}  # {book_id: {"current": N, "total": M}}
        os.makedirs(self.persist_directory, exist_ok=True)

        # 初始化 ChromaDB
        # v2：章节滑窗切块 + 中文 embedding + cosine 空间。
        # 与旧版"整章一向量 + 英文 MiniLM + L2"空间不兼容，故换新集合名隔离，
        # 旧集合保留作重建素材与回滚备份（scripts/rebuild_vectors.py）。
        self.chroma_client = chromadb.PersistentClient(path=self.persist_directory)
        collection_kwargs = dict(
            name="book_chapters_v2",
            metadata={
                "description": "书籍章节滑窗切块向量库（cosine + bge-zh）",
                "hnsw:space": "cosine",
            },
        )
        ef = None
        try:
            from app.services.embeddings import get_embedding_function
            ef = get_embedding_function()
        except RuntimeError:
            raise  # 模型缺失必须显式报错：混用不同空间的向量是静默的检索毒药
        if ef is not None:
            collection_kwargs["embedding_function"] = ef
        self.collection = self.chroma_client.get_or_create_collection(**collection_kwargs)

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

    @staticmethod
    def _epub_doc_text(item) -> str:
        """提取单个 EPUB 文档项的纯文本（保留段落结构）"""
        content = item.get_content().decode('utf-8', errors='ignore')
        # 保留段落结构：块级标签替换为换行
        text = re.sub(r'</?(?:p|div|h[1-6]|li|ul|ol|tr|td|th|br|section|article|blockquote|dl|dt|dd)[^>]*>', '\n', content, flags=re.IGNORECASE)
        # 剩余行内标签替换为空格
        text = re.sub(r'<[^>]+>', ' ', text)
        # 折叠空白
        text = re.sub(r'[ \t]+', ' ', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()

    def extract_text_from_epub(self, file_path: str) -> Tuple[str, dict]:
        """从EPUB提取文本和元数据（按spine阅读顺序）"""
        book = epub.read_epub(file_path)
        full_text = ""

        metadata = self._epub_metadata(book, file_path)

        # 建立 id -> item 索引
        items_by_id = {item.get_id(): item for item in book.get_items()}

        # 按 spine 顺序遍历（spine 定义阅读顺序）
        for idref, _ in book.spine:
            item = items_by_id.get(idref)
            if item is None or item.get_type() != 9:  # 跳过非文档项
                continue
            text = self._epub_doc_text(item)
            if text:
                full_text += text + "\n\n"

        return full_text, metadata

    @staticmethod
    def _epub_metadata(book, file_path: str) -> dict:
        """读取 EPUB 元数据（标题/作者）"""
        return {
            "title": book.get_metadata('DC', 'title')[0][0] if book.get_metadata('DC', 'title') else Path(file_path).stem,
            "author": book.get_metadata('DC', 'creator')[0][0] if book.get_metadata('DC', 'creator') else "未知作者",
            "format": "EPUB"
        }

    def _extract_epub_native(self, file_path: str) -> Optional[Tuple[dict, List[Chapter], List[TocItem]]]:
        """EPUB 原生目录切分（零 AI 成本、边界精确）。

        思路：EPUB 规范自带 TOC（NCX/nav），多数正规书籍直接给出了
        章节标题 → spine 文档的映射。命中且可用时，比"AI 看前 5000 字猜目录"
        准得多。返回 (metadata, chapters, toc_items)，不可用时返回 None，
        由调用方降级到 AI/正则路径。
        """
        from urllib.parse import unquote

        book = epub.read_epub(file_path)
        metadata = self._epub_metadata(book, file_path)

        # 1. 按 spine 顺序抽取每个文档的文本，同时建立 名称 -> 文档序号 索引
        items_by_id = {item.get_id(): item for item in book.get_items()}
        docs: List[str] = []
        doc_index_by_name: dict = {}

        for idref, _ in book.spine:
            item = items_by_id.get(idref)
            if item is None or item.get_type() != 9:  # ITEM_DOCUMENT
                continue
            pos = len(docs)
            text = self._epub_doc_text(item)
            docs.append(text)
            name = item.get_name().lstrip('/_').lower()
            doc_index_by_name.setdefault(name, pos)
            doc_index_by_name.setdefault(os.path.basename(name), pos)

        # 2. 递归遍历原生 TOC，把每个条目的 href 映射到文档序号
        entries: List[Tuple[int, str, int]] = []  # (doc_idx, title, level)

        def walk(toc_nodes, level: int):
            for link in toc_nodes:
                href = unquote(getattr(link, 'href', '') or '').split('#')[0].lstrip('/_')
                title = re.sub(r'\s+', ' ', (getattr(link, 'title', '') or '').strip())
                idx = None
                if href:
                    idx = doc_index_by_name.get(href.lower())
                    if idx is None:
                        idx = doc_index_by_name.get(os.path.basename(href).lower())
                if idx is not None and title:
                    entries.append((idx, title, level))
                children = getattr(link, 'children', None)
                if children:
                    walk(children, level + 1)

        try:
            walk(book.toc, 1)
        except Exception as e:
            print(f"EPUB 原生目录解析异常: {e}")
            return None

        # 3. 按文档序号排序；多个 TOC 条目指向同一文档时保留第一个（更高层级）
        entries.sort(key=lambda e: (e[0], e[2]))
        uniq: List[Tuple[int, str, int]] = []
        for idx, title, level in entries:
            if uniq and uniq[-1][0] == idx:
                continue
            uniq.append((idx, title, level))

        # 少于 2 个可用锚点说明这本书的原生目录不可信（缺失/全是无标题项）
        if len(uniq) < 2:
            return None

        # 4. 以锚点文档为边界切分章节
        chapters: List[Chapter] = []

        # 第一个锚点之前的封面/声明等前置内容
        if uniq[0][0] > 0:
            lead = "\n\n".join(d for d in docs[0:uniq[0][0]] if d).strip()
            if len(lead) > 50:
                chapters.append(Chapter(
                    chapter_id=str(uuid.uuid4()), book_id="",
                    title="前置内容", content=lead,
                    word_count=len(lead), chapter_index=0
                ))

        for i, (idx, title, level) in enumerate(uniq):
            end = uniq[i + 1][0] if i + 1 < len(uniq) else len(docs)
            content = "\n\n".join(d for d in docs[idx:end] if d).strip()
            if len(content) <= 50:
                continue
            chapters.append(Chapter(
                chapter_id=str(uuid.uuid4()), book_id="",
                title=title, content=content,
                word_count=len(content), chapter_index=len(chapters)
            ))

        if len(chapters) < 2:
            return None

        toc_items = [TocItem(title=t, level=l, pattern=t) for (_, t, l) in uniq]
        return metadata, chapters, toc_items

    @staticmethod
    def _read_text_file(file_path: str) -> str:
        """读取文本文件，自动探测编码（中文 TXT 常见 GBK/GB18030/Big5）"""
        with open(file_path, "rb") as f:
            raw = f.read()

        # BOM 优先
        if raw.startswith(b'\xef\xbb\xbf'):
            return raw.decode("utf-8-sig")

        # 按可靠性顺序尝试：UTF-8 最严格，先试；GB18030 几乎不会失败，放后面兜底
        for enc in ("utf-8", "gb18030", "big5", "shift_jis"):
            try:
                text = raw.decode(enc)
                # gb18030 会把 UTF-8 字节流"成功"解成乱码，
                # 用替换符/私用区字符占比做启发式校验
                suspicious = sum(1 for c in text if '\ue000' <= c <= '\uf8ff')
                if enc != "utf-8" and suspicious > len(text) * 0.01:
                    continue
                return text
            except (UnicodeDecodeError, LookupError):
                continue

        # 全部失败：UTF-8 宽松解码，坏字节替换为占位符而不是整个文件报错
        return raw.decode("utf-8", errors="replace")

    def extract_text(self, file_path: str, book_id: str = "") -> Tuple[str, dict]:
        """自动检测格式并提取文本"""
        suffix = Path(file_path).suffix.lower()

        if suffix == ".pdf":
            return self.extract_text_from_pdf(file_path, book_id)
        elif suffix == ".epub":
            return self.extract_text_from_epub(file_path)
        elif suffix == ".txt":
            text = self._read_text_file(file_path)
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
            # 提取章节号作为分组 key——必须保留编号，否则 Chapter 1/Chapter 2
            # 会因前 4 字符相同（"Chap"）被误合并成同一组
            m = re.search(r'第[一二三四五六七八九十百千万零\d]+[章回节卷]', title)
            if m:
                key = m.group()
            else:
                m2 = re.match(
                    r'^\s*(?:chapter|part|section)\s+[\dIVXLCDM]+',
                    title, re.IGNORECASE
                )
                if m2:
                    key = re.sub(r'\s+', ' ', m2.group()).strip().lower()
                else:
                    m3 = re.match(r'^\s*\d+(?:\.\d+)*', title)
                    if m3:
                        key = m3.group().strip()
                    else:
                        # 无编号标题（序言/附录等），取前 4 个有效中文字作 key
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

    @staticmethod
    def _heading_score(text: str, match_start: int, match_end: int,
                       match_priority: int) -> float:
        """计算匹配位置是真实章节标题的置信度 (0~1)。

        综合考虑：行长度、前后空白隔离、距页首标记距离、匹配精度、行末标点。
        match_priority: 0=精确行首锚定, 1=子串匹配, 2=宽松前缀匹配（越小越准）。
        """
        score = 0.0
        line = text[match_start:match_end]

        # 1. 标题通常短小精悍
        line_len = len(line)
        if line_len <= 30:
            score += 0.25
        elif line_len <= 50:
            score += 0.12

        # 2. 前后空白隔离（真正标题前后常有空行）
        before = text[max(0, match_start - 15):match_start]
        after = text[match_end:match_end + 15]
        if '\n\n' in before or match_start == 0:
            score += 0.18
        if after.startswith('\n') or match_end >= len(text) - 5:
            score += 0.18

        # 3. 距 [PAGE X] 标记近 → 大概率是新页首行标题
        page_marker = re.search(
            r'\[PAGE\s*\d+\](?!.*\[PAGE\s*\d+\])',
            text[max(0, match_start - 120):match_start]
        )
        if page_marker:
            dist = match_start - (max(0, match_start - 120) + page_marker.start())
            if dist < 100:
                score += 0.15

        # 4. 匹配精度：精确锚定比模糊匹配可靠
        if match_priority == 0:
            score += 0.15
        elif match_priority == 1:
            score += 0.05

        # 5. 行末无句末标点（标题通常不以句号/逗号收尾）
        if not re.search(r'[。，；：！？,\.:!?]$', line.rstrip()):
            score += 0.09

        return score

    @staticmethod
    def _deduplicate_nearby(positions: list, min_gap: int = 150) -> list:
        """合并同一 TOC item 间距过近的重复匹配，保留置信度最高的。

        positions: [(start, end, score, toc_item), ...]，已按 start 排序。
        min_gap: 同一标题两次匹配之间的最小间距（字符数）。
        """
        if len(positions) <= 1:
            return positions

        merged = []
        # 按标题分组，组内合并近邻匹配（不会误伤不同的章节标题）
        groups = {}
        for p in positions:
            key = p[3].title if p[3] else "__leading__"
            groups.setdefault(key, []).append(p)

        for key, group in groups.items():
            group.sort(key=lambda x: x[0])
            cluster_start = group[0]
            cluster_best = group[0]
            for cur in group[1:]:
                if cur[0] - cluster_start[0] < min_gap:
                    if cur[2] > cluster_best[2]:
                        cluster_best = cur
                else:
                    merged.append(cluster_best)
                    cluster_start = cur
                    cluster_best = cur
            merged.append(cluster_best)

        merged.sort(key=lambda x: x[0])
        return merged

    @staticmethod
    def _merge_nested_anchors(positions: list, min_gap: int = 60) -> list:
        """相邻过近的锚点按父子标题合并，避免父章被切分过滤器整章丢弃。

        典型场景：真实标题页"第一章 让爱融入生活"行下仅一行就是小节标题
        "引言"（相距十来字）。两个锚点都保留时，父章切片只有标题那十几个字，
        过不了 word_count 过滤 → "第一章"从章节列表里凭空消失。
        规则：间距 < min_gap 视为同一标题块——删掉层级更深的那个（level 数值大），
        同级则删后者；被删锚点的内容自然并入保留锚点的章节切片。
        positions: [(start, end, score, toc_item), ...]，已按 start 排序。
        """
        if len(positions) <= 1:
            return positions

        def level_of(p) -> int:
            # 前置虚拟锚点（toc_item=None）层级最深，让位于任何真实标题
            return p[3].level if p[3] is not None else 99

        merged = [positions[0]]
        for cur in positions[1:]:
            prev = merged[-1]
            if cur[0] - prev[0] < min_gap:
                if level_of(cur) < level_of(prev):
                    merged[-1] = cur  # 前一个是小节标题、后一个才是章标题：换锚
                # 否则跳过 cur，其内容并入 prev 章节
                continue
            merged.append(cur)
        return merged

    def _mask_toc_pages(self, full_text: str, toc_items: List[TocItem]) -> str:
        """把目录页区块替换为空白（严格保留字符偏移）。

        目录页的"第一章 xxx [页码]"与正文标题行长得几乎一样，锚定时部分章节
        会错锚到目录页（排在书前部的扉页/目录），导致章节顺序错乱——典型症状
        是"第一章"排到"译序/前言"之前。检测特征：≥3 个不同目录标题在连续行
        （容许 ≤2 空行）中成串出现，判定为目录区块并抹除。
        另设 prose 保护：行后两个非空行内出现长句的不抹（EPUB 目录块可能
        与正文章标题只隔一行，如游子吟"…修订版前言⏎⏎前言⏎⏎正文"）。
        """
        titles = []
        for it in toc_items:
            t = (it.pattern or it.title or "").strip()
            if len(t) >= 2 and t not in titles:
                titles.append(t)
        if len(titles) < 4:
            return full_text

        # 目录页只会出现在书的前部，扫前 1/8（至少 5000 字）即可
        head_end = min(len(full_text), max(5000, len(full_text) // 8))
        head, tail = full_text[:head_end], full_text[head_end:]

        def entry_title(line: str) -> Optional[str]:
            s = re.sub(r'[\s.…·・\-—–_]*\d{1,4}\s*$', '', line.strip())
            if len(s) < 2:
                return None
            for t in titles:
                if s == t or s.startswith(t):
                    return t
            return None

        lines = head.split("\n")
        mask_flags = [False] * len(lines)
        run: List[int] = []
        run_titles: set = set()
        gap = 0

        def followed_by_prose(li: int) -> bool:
            """行后两个非空行内出现长句 → 该行为真实标题而非目录条目。

            目录条目后面跟着的仍是短目录行；正文标题（哪怕紧贴目录块）
            后面很快就是正文段落。EPUB 常无空行分隔目录页与正文，
            没有这层保护会把紧挨目录块的正文章标题一起抹掉。
            """
            seen = 0
            for j in range(li + 1, min(len(lines), li + 8)):
                s = lines[j].strip()
                if not s:
                    continue
                seen += 1
                if len(s) > 35:
                    return True
                if seen >= 2:
                    return False
            return False

        def flush():
            if len(run_titles) >= 3:
                for li in run:
                    if not followed_by_prose(li):
                        mask_flags[li] = True

        for li, raw in enumerate(lines):
            t = entry_title(raw)
            if t is not None:
                run.append(li)
                run_titles.add(t)
                gap = 0
            elif raw.strip() == "" and run and gap < 2:
                gap += 1
            else:
                flush()
                run, run_titles, gap = [], set(), 0
        flush()

        if not any(mask_flags):
            return full_text
        out = [" " * len(ln) if m else ln for ln, m in zip(lines, mask_flags)]
        return "\n".join(out) + tail

    def split_by_toc(self, full_text: str, toc_items: List[TocItem]) -> List[Chapter]:
        """根据目录切分章节。

        优化点（相比旧实现）：
        1. 三级匹配按优先级分层合并，每级只扫一次全文（3 次 vs 旧版 3n 次）
        2. 标题置信度打分替代盲目的 matches[-1]
        3. 邻近去重，消除同一标题的重复低置信匹配
        4. 目录页掩码，防止锚点错落到目录页造成章节乱序
        5. 父子标题合并，章标题与紧随其后的小节标题不再互斥导致整章丢失
        """
        if not toc_items:
            return self._split_by_paragraphs(full_text)

        full_text = self._mask_toc_pages(full_text, toc_items)

        # ---- 构建三级模式列表 ----
        # 每级: [(toc_item, index_in_level, regex_string)]
        levels = {0: [], 1: [], 2: []}
        for item in toc_items:
            if not item.pattern:
                continue
            pattern = item.pattern.strip()
            escaped = re.escape(pattern)
            # 级别 0：精确行首锚定（^ $ 依赖 re.MULTILINE）
            levels[0].append((item, rf'^\s*{escaped}[^\n。？！]{{0,30}}$'))
            # 级别 1：子串匹配
            levels[1].append((item, escaped))
            # 级别 2：宽松前缀匹配
            if len(pattern) >= 3:
                prefix = re.escape(pattern[:15])
                levels[2].append((item, rf'^.*{prefix}.{{0,30}}$'))

        matched_items = set()   # 已找到高置信匹配的 TOC 标题
        all_scored = []         # [(start, end, score, toc_item)]

        # ---- 逐级扫描：高级别命中后跳过低级别 ----
        for priority in (0, 1, 2):
            pending = [(it, rx) for it, rx in levels[priority]
                       if it.title not in matched_items]
            if not pending:
                continue

            # 每个 pending item 包进一个捕获组，用 | 合并为单次扫描
            groups = [rx for _, rx in pending]          # 第 i 个正则
            group_owner = [it for it, _ in pending]     # 第 i 个正则归属的 TOC item
            combined = '|'.join(f'({rx})' for rx in groups)

            for m in re.finditer(combined, full_text, flags=re.MULTILINE):
                # 定位是哪个捕获组命中了（交替中只有一个非 None）
                for gid in range(len(groups)):
                    if m.group(gid + 1) is not None:
                        toc_item = group_owner[gid]
                        break
                else:
                    continue

                score = self._heading_score(full_text, m.start(), m.end(), priority)
                all_scored.append((m.start(), m.end(), score, toc_item))

            # 本级别结束后，标记已获高置信匹配的 item（≥0.50 不再降级匹配）
            for start, end, score, it in all_scored:
                if score >= 0.50:
                    matched_items.add(it.title)

        if not all_scored:
            return self._split_by_paragraphs(full_text)

        # ---- 每个 TOC item 只保留置信度最高的那个匹配 ----
        best_per_item = {}
        for start, end, score, toc_item in all_scored:
            key = toc_item.title
            if key not in best_per_item or score > best_per_item[key][2]:
                best_per_item[key] = (start, end, score, toc_item)

        # ---- 按位置排序 + 邻近去重 + 父子标题合并 ----
        positions = sorted(best_per_item.values(), key=lambda x: x[0])
        positions = self._deduplicate_nearby(positions, min_gap=150)
        positions = self._merge_nested_anchors(positions, min_gap=60)

        # 首页/目录前置章节
        if positions and positions[0][0] > 0:
            positions.insert(0, (0, 0, 1.0, None))

        # ---- 切分 ----
        chapters = []
        for i, (start_pos, _, _, toc_item) in enumerate(positions):
            end_pos = positions[i + 1][0] if i + 1 < len(positions) else len(full_text)

            content = full_text[start_pos:end_pos].strip()
            word_count = len(content)

            if word_count > 50:
                title = toc_item.title if toc_item else "序言/引言"
                chapters.append(Chapter(
                    chapter_id=str(uuid.uuid4()),
                    book_id="",
                    title=title,
                    content=content,
                    word_count=word_count,
                    chapter_index=len(chapters),
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

    async def process_book(self, file_path: str, book_id: str, content_hash: str = "") -> BookAnalysisResult:
        """处理书籍：提取文本、识别目录、切分章节、向量化存储"""

        suffix = Path(file_path).suffix.lower()

        # EPUB 优先走原生目录（零 AI 成本、边界精确），不可用再降级通用链路
        native = self._extract_epub_native(file_path) if suffix == ".epub" else None

        if native:
            metadata, chapters, toc_items = native
            print(f"EPUB 原生目录命中：切出 {len(chapters)} 章（未调用 AI）")
        else:
            # 1. 提取文本
            full_text, metadata = self.extract_text(file_path, book_id)

            # 2. 先用AI识别目录（仅看前5000字，省成本）
            toc_items = await self.detect_toc_by_ai(full_text[:5000])

            # 3. AI失败时的保底方案：正则扫描全文找章节（零成本）
            if not toc_items:
                toc_items = self._fallback_toc_detection(full_text)

            # 4. 根据目录切分章节
            chapters = self.split_by_toc(full_text, toc_items)

        # 5. 空章节保护：加密 PDF、空白文件、缺 OCR 的扫描版都会走到这里
        if not chapters:
            raise ValueError(
                "未能提取到有效正文：文件可能已加密、内容为空，"
                "或是扫描版且缺少 OCR 支持"
            )

        # 6. 填充book_id
        for chapter in chapters:
            chapter.book_id = book_id

        # 7. 存储到ChromaDB
        await self.store_chapters_to_chroma(book_id, chapters, book_title=metadata.get("title", ""))

        # 8. 返回分析结果
        total_words = sum(ch.word_count for ch in chapters)

        return BookAnalysisResult(
            book_id=book_id,
            title=metadata.get("title", Path(file_path).stem),
            author=metadata.get("author"),
            total_chapters=len(chapters),
            total_words=total_words,
            chapters=chapters,
            toc=toc_items,
            file_format=metadata.get("format", "Unknown"),
            content_hash=content_hash or None
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

    def _split_into_chunks(self, text: str, target: int = None, overlap: int = None) -> List[Tuple[str, int]]:
        """把章节正文切成滑窗小块，返回 [(块文本, 重叠前缀长度), ...]。

        策略：先按行聚合成 ≤target 字的"单元"（超长段落按 target 硬切），
        再给每块（首块除外）前置上一块尾部 overlap 字——防止关键句子恰好
        跨在块边界上被切成两半、两边都召不回。前置长度记在 prefix_len 里，
        重组整章时据此剥离，保证阅读视图无重复文字。
        """
        target = target or settings.chunk_size
        overlap = overlap if overlap is not None else settings.chunk_overlap
        if not text:
            return []
        if len(text) <= target:
            return [(text, 0)]

        # 1. 聚合成不重叠的单元
        units: List[str] = []
        buf = ""
        for para in [p for p in text.split("\n") if p.strip()]:
            while len(para) > target:  # 超长段落硬切
                if buf:
                    units.append(buf)
                    buf = ""
                units.append(para[:target])
                para = para[target:]
            candidate = (buf + "\n" + para) if buf else para
            if len(candidate) > target:
                units.append(buf)
                buf = para
            else:
                buf = candidate
        if buf:
            units.append(buf)

        # 2. 滑窗重叠：第 i 块前置第 i-1 块的尾部
        chunks: List[Tuple[str, int]] = [(units[0], 0)]
        for unit in units[1:]:
            prev = chunks[-1][0]
            tail = prev[-overlap:] if overlap > 0 and len(prev) > overlap else (prev if overlap > 0 else "")
            chunks.append((tail + "\n" + unit, len(tail)))
        return chunks

    @staticmethod
    def _assemble_chunks(pairs: List[Tuple[str, int]]) -> str:
        """把 [(块文本, 重叠前缀长度)] 按顺序拼回整章（剥离重叠前缀，无重复文字）"""
        parts = [c if prefix_len == 0 else c[prefix_len + 1:] for c, prefix_len in pairs]
        return "\n".join(parts)

    async def store_chapters_to_chroma(self, book_id: str, chapters: List[Chapter], book_title: str = ""):
        """将章节滑窗切块后存储到 ChromaDB（先清旧数据，重复解析不残留）"""

        if not chapters:
            return

        # 幂等：同一 book_id 重新解析时，先删掉它自己的旧块
        self.delete_book_chapters(book_id)

        ids = []
        documents = []
        metadatas = []

        for chapter in chapters:
            cleaned_content = self._clean_chapter_content(chapter.content)
            for idx, (chunk_text, prefix_len) in enumerate(self._split_into_chunks(cleaned_content)):
                ids.append(f"{chapter.chapter_id}#{idx}")
                documents.append(chunk_text)
                metadatas.append({
                    "book_id": book_id,
                    "book_title": book_title,
                    "chapter_id": chapter.chapter_id,
                    "title": chapter.title,
                    "chapter_index": chapter.chapter_index,
                    "chunk_index": idx,
                    "prefix_len": prefix_len,
                    "word_count": chapter.word_count,
                })

        # 分批添加（整本书一次 add 会给 embedding 攒出超大 batch）
        batch = 64
        for i in range(0, len(ids), batch):
            self.collection.add(
                ids=ids[i:i + batch],
                documents=documents[i:i + batch],
                metadatas=metadatas[i:i + batch],
            )

    async def search_chapters(self, query: str, book_ids: Optional[List[str]] = None, n_results: int = 5) -> List[ChapterSearchResult]:
        """语义检索：返回命中的滑窗块（整块内容即上下文，不再截章首300字）"""

        where_filter = None
        if book_ids:
            if len(book_ids) == 1:
                where_filter = {"book_id": book_ids[0]}
            else:
                where_filter = {"book_id": {"$in": book_ids}}

        results = self.collection.query(
            query_texts=[query],
            n_results=max(n_results * 3, 10),  # 多召后过滤：阈值筛掉垃圾命中后仍要够数
            where=where_filter,
            include=["documents", "metadatas", "distances"]
        )

        search_results = []
        seen_adjacent = set()  # 同章相邻块重叠区只保留分高的一块
        if results['ids'] and results['ids'][0]:
            for i, doc_id in enumerate(results['ids'][0]):
                content = results['documents'][0][i]
                metadata = results['metadatas'][0][i]
                distance = results['distances'][0][i]

                # cosine 距离 ∈ [0, 2]；超过阈值视为无关，不进 LLM 上下文
                if distance > settings.search_max_distance:
                    continue

                chapter_id = metadata.get('chapter_id', doc_id)
                chunk_index = metadata.get('chunk_index', 0)
                adj_key = (chapter_id, chunk_index)
                if (chapter_id, chunk_index - 1) in seen_adjacent or adj_key in seen_adjacent:
                    continue
                seen_adjacent.add(adj_key)

                search_results.append(ChapterSearchResult(
                    chapter_id=chapter_id,
                    book_id=metadata.get('book_id', ''),
                    book_title=metadata.get('book_title', ''),
                    title=metadata.get('title', ''),
                    content_snippet=content,
                    chapter_index=metadata.get('chapter_index', 0),
                    relevance_score=max(0.0, min(1.0, 1 - distance)),  # cosine 相似度，诚实刻度
                ))
                if len(search_results) >= n_results:
                    break

        return search_results

    def get_chapter_by_id(self, chapter_id: str) -> Optional[Chapter]:
        """根据ID获取章节（按块拼回整章，剥离滑窗重叠前缀）"""
        results = self.collection.get(
            where={"chapter_id": chapter_id},
            include=["documents", "metadatas"]
        )

        if not results['ids']:
            return None

        pairs = sorted(
            [(doc, m.get('chunk_index', 0), m.get('prefix_len', 0), m)
             for doc, m in zip(results['documents'], results['metadatas'])],
            key=lambda t: t[1],
        )
        metadata = pairs[0][3]
        content = self._assemble_chunks([(p[0], p[2]) for p in pairs])

        return Chapter(
            chapter_id=chapter_id,
            book_id=metadata.get('book_id', ''),
            title=metadata.get('title', ''),
            content=content,
            word_count=len(content),
            chapter_index=metadata.get('chapter_index', 0)
        )

    def get_full_chapters(self, book_id: str) -> List[Chapter]:
        """按书取全部章节完整内容（块→章聚合，供 AI 工具整书分析用）"""
        results = self.collection.get(
            where={"book_id": book_id},
            include=["documents", "metadatas"]
        )
        grouped = {}
        for doc, metadata in zip(results['documents'] or [], results['metadatas'] or []):
            cid = metadata.get('chapter_id', '')
            grouped.setdefault(cid, []).append(
                (doc, metadata.get('chunk_index', 0), metadata.get('prefix_len', 0), metadata)
            )

        chapters = []
        for cid, items in grouped.items():
            items.sort(key=lambda t: t[1])
            content = self._assemble_chunks([(it[0], it[2]) for it in items])
            meta = items[0][3]
            chapters.append(Chapter(
                chapter_id=cid,
                book_id=meta.get('book_id', book_id),
                title=meta.get('title', ''),
                content=content,
                word_count=len(content),
                chapter_index=meta.get('chapter_index', 0),
            ))
        return sorted(chapters, key=lambda c: c.chapter_index)

    def fulltext_search(self, book_id: str, keyword: str, limit: int = 20) -> List[dict]:
        """全文关键词搜索：按块收集命中、按章聚合去重（重叠区会重复命中同一句）"""
        results = self.collection.get(
            where={"book_id": book_id},
            include=["documents", "metadatas"]
        )
        matches = []
        seen_snippets = set()
        if results['ids']:
            for i, doc_id in enumerate(results['ids']):
                content = results['documents'][i]
                metadata = results['metadatas'][i]
                pos = 0
                while True:
                    idx = content.find(keyword, pos)
                    if idx == -1 or len(matches) >= limit:
                        break
                    start = max(0, idx - 30)
                    end = min(len(content), idx + len(keyword) + 80)
                    snippet = ('...' if start > 0 else '') + content[start:end] + ('...' if end < len(content) else '')
                    if snippet not in seen_snippets:
                        seen_snippets.add(snippet)
                        matches.append({
                            "chapter_id": metadata.get("chapter_id", doc_id),
                            "chapter_title": metadata.get("title", ""),
                            "chapter_index": metadata.get("chapter_index", 0),
                            "chunk_index": metadata.get("chunk_index", 0),
                            "position": idx,
                            "snippet": snippet
                        })
                    pos = idx + 1
                if len(matches) >= limit:
                    break
        return sorted(matches, key=lambda m: (m["chapter_index"], m["chunk_index"], m["position"]))

    def delete_book_chapters(self, book_id: str):
        """删除指定书籍的所有切块"""
        results = self.collection.get(
            where={"book_id": book_id}
        )

        if results['ids']:
            self.collection.delete(ids=results['ids'])


# 单例
book_processor = BookProcessor()
