import { useState, useEffect, useRef, useCallback } from 'react';
import Bookshelf from './components/Bookshelf.jsx';
import BookReader from './components/BookReader.jsx';
import ReviewPage from './components/ReviewPage.jsx';
import { TOOL_LABELS } from './tools.js';

const API_BASE = '';

// 资产区（v2.4）：后端 asset ↔ 组件侧收藏形态 双向映射（note↔qa 保持旧调用点零改动）
function apiToFav(a) {
    return {
        id: a.asset_id,
        type: a.type === 'note' ? 'qa' : a.type,
        toolId: a.tool_id || undefined,
        toolLabel: a.tool_name || undefined,
        outputType: a.output_type || 'text',
        question: a.title || '',
        answer: a.content || '',
        savedAt: (a.created_at || '').replace('T', ' ').slice(0, 16),
    };
}
function favToApi(f, bookId) {
    return {
        book_id: bookId,
        type: f.type === 'qa' ? 'note' : f.type,
        content: f.answer || '',
        title: f.question || f.toolLabel || '收藏',
        tool_id: f.toolId || null,
        tool_name: f.toolLabel || null,
        output_type: f.outputType || 'text',
        source: f.source || null,
    };
}

// hash 路由：#/ 书架；#/book/{id} 书内；#/review 复习页（v2.3）
function parseHash() {
    const m = (window.location.hash || '').match(/^#\/book\/(.+)$/);
    if (m) return { view: 'book', bookId: decodeURIComponent(m[1]) };
    if ((window.location.hash || '') === '#/review') return { view: 'review', bookId: null };
    return { view: 'shelf', bookId: null };
}

// 多书阅读进度：{bookId: {chapterId, chapterTitle, updatedAt}}
const PROGRESS_KEY = 'reading_progress_map';
function loadProgressMap() {
    try {
        const map = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        // 迁移旧单书进度键
        const legacy = JSON.parse(localStorage.getItem('reading_progress') || 'null');
        if (legacy?.bookId && !map[legacy.bookId]) {
            map[legacy.bookId] = { chapterId: legacy.chapterId, updatedAt: Date.now() };
        }
        return map;
    } catch { return {}; }
}

function App() {
    const [route, setRoute] = useState(parseHash);
    const [books, setBooks] = useState([]);
    const [booksLoaded, setBooksLoaded] = useState(false);
    const [currentBook, setCurrentBook] = useState(null);
    const [currentChapter, setCurrentChapter] = useState(null);
    const [uploadProgress, setUploadProgress] = useState(null); // {phase, current, total, ocrProgress?}
    const [messages, setMessages] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [sessionId, setSessionId] = useState(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [busyToolId, setBusyToolId] = useState(null);
    const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1280);
    // 资产区（v2.4）：收藏后端化按书归属；旧 localStorage 收藏首次进书一次性迁移
    const [favorites, setFavorites] = useState([]);
    const favMigratedRef = useRef(false);
    // 专家模式：专家包列表 / 当前会话绑定的专家 / 起手式生成中
    const [experts, setExperts] = useState([]);
    const [activeExpertId, setActiveExpertId] = useState(null);
    const [expertOpening, setExpertOpening] = useState(false);
    const [progressMap, setProgressMap] = useState(loadProgressMap);
    // v2.7 划线：按书加载全部划线；quoteDraft=「加入对话」暂存的选区引用（发问/切书/切会话时清除）
    const [highlights, setHighlights] = useState([]);
    const [quoteDraft, setQuoteDraft] = useState(null);
    useEffect(() => {
        if (!currentBook?.book_id) { setHighlights([]); return; }
        setQuoteDraft(null);
        fetch(`${API_BASE}/highlights?book_id=${currentBook.book_id}`).then(r => r.json())
            .then(d => setHighlights(d.highlights || [])).catch(() => {});
    }, [currentBook?.book_id]);

    const handleAddHighlights = async (frags) => {
        if (!currentBook || !currentChapter) return;
        const created = [];
        for (const f of frags) {
            try {
                const res = await fetch(`${API_BASE}/highlights`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        book_id: currentBook.book_id,
                        chapter_id: currentChapter.chapter_id,
                        start_p: f.start_p,
                        text: f.text,
                        chapter_title: currentChapter.title,
                    })
                });
                const d = await res.json().catch(() => ({}));
                if (res.ok && d.highlight) created.push(d.highlight);
            } catch { /* 单段网络失败跳过，其余照常 */ }
        }
        if (created.length) {
            setHighlights(prev => {
                const seen = new Set(prev.map(h => h.highlight_id));
                return [...prev, ...created.filter(h => !seen.has(h.highlight_id))];
            });
        }
    };

    const handleRemoveHighlight = async (id) => {
        try {
            const res = await fetch(`${API_BASE}/highlights/${id}`, { method: 'DELETE' });
            if (res.ok) setHighlights(prev => prev.filter(h => h.highlight_id !== id));
        } catch { /* 后端未删：保留划线，下次进书状态仍一致 */ }
    };
    // 知识卡片统计（v2.3）：书架徽标 + 书内抽屉徽标共用；复习/抽卡/删卡后刷新
    const [cardStats, setCardStats] = useState({ total: 0, due: 0, stats: {} });
    const loadCardStats = useCallback(() => {
        fetch(`${API_BASE}/cards/stats`).then(r => r.json())
            .then(s => setCardStats({ total: s.total || 0, due: s.due || 0, stats: s.stats || {} }))
            .catch(() => {});
    }, []);
    useEffect(() => { loadCardStats(); }, [loadCardStats, route.view]);

    // 从搜索结果/来源标注进书时暂存目标章，进书 effect 消费
    const pendingChapterRef = useRef(null);
    // 竞态：仅接受最后一次请求的章节内容
    const loadingChapterRef = useRef(null);

    // 资产区（v2.4）：进书拉取本书资产；首次进书把旧 localStorage 收藏一次性迁移到后端
    // （全部成功才清旧 key，失败条目写回等下次进书重试）
    const loadAssets = useCallback((bookId) => {
        fetch(`${API_BASE}/assets?book_id=${encodeURIComponent(bookId)}`)
            .then(r => r.json())
            .then(d => setFavorites((d.assets || []).map(apiToFav)))
            .catch(() => {});
    }, []);
    useEffect(() => {
        if (route.view !== 'book' || !currentBook) return;
        const bookId = currentBook.book_id;
        if (favMigratedRef.current) { loadAssets(bookId); return; }
        let legacy = [];
        try { legacy = JSON.parse(localStorage.getItem('reading_favorites') || '[]'); } catch { legacy = []; }
        if (!Array.isArray(legacy) || legacy.length === 0) { favMigratedRef.current = true; loadAssets(bookId); return; }
        favMigratedRef.current = true;
        Promise.allSettled(legacy.map(f => fetch(`${API_BASE}/assets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(favToApi(f, bookId)),
        }))).then(rs => {
            const failed = legacy.filter((_, i) => rs[i].status !== 'fulfilled' || !rs[i].value.ok);
            if (failed.length === 0) localStorage.removeItem('reading_favorites');
            else localStorage.setItem('reading_favorites', JSON.stringify(failed));
            loadAssets(bookId);
        });
    }, [route.view, currentBook?.book_id, loadAssets]);

    // hash 路由同步
    useEffect(() => {
        const onHash = () => setRoute(parseHash());
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);

    // 书籍列表
    useEffect(() => {
        fetch(`${API_BASE}/books/list`)
            .then(res => res.json())
            .then(data => { setBooks(data.books || []); })
            .catch(err => console.log('获取书籍列表失败（首次加载无数据是正常的）:', err))
            .finally(() => setBooksLoaded(true));
    }, []);

    // 专家包（展示元数据，落文件即生效）
    useEffect(() => {
        fetch(`${API_BASE}/experts`)
            .then(res => res.json())
            .then(data => setExperts(data.experts || []))
            .catch(() => {});
    }, []);

    // 加载章节内容（处理竞态）
    const loadChapterContent = async (chapter) => {
        const chapterId = chapter.chapter_id;
        loadingChapterRef.current = chapterId;
        try {
            const res = await fetch(`${API_BASE}/books/chapters/${chapterId}`);
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            if (loadingChapterRef.current === chapterId) {
                setCurrentChapter(data);
            }
        } catch (err) {
            console.warn('获取章节失败（可能为未入索引的孤章）:', err.message);
            // 孤章（目录有、内容未入索引，如非暴力沟通"译序"）：明示缺失，不再无限"加载中"
            if (loadingChapterRef.current === chapterId) {
                setCurrentChapter({ ...chapter, content: '', loadError: true });
            }
        }
    };

    // 路由 → 进书（含刷新深链 #/book/{id}；同书重进用于消费搜索跳转的目标章）
    useEffect(() => {
        if (route.view !== 'book' || !booksLoaded) return;
        const book = books.find(b => b.book_id === route.bookId);
        if (!book) { window.location.hash = '#/'; return; }
        const wantId = pendingChapterRef.current;
        if (currentBook?.book_id === book.book_id) {
            // 已在书内（返回书架未清态）：仅处理「跳到指定章」
            if (wantId) {
                pendingChapterRef.current = null;
                const ch = book.chapters?.find(c => c.chapter_id === wantId);
                if (ch) {
                    setCurrentChapter(ch);
                    updateProgress(book.book_id, ch);
                    if (!ch.content) loadChapterContent(ch);
                }
            }
            return;
        }
        setCurrentBook(book);
        let chapter = null;
        pendingChapterRef.current = null;
        if (wantId) chapter = book.chapters?.find(c => c.chapter_id === wantId) || null;
        if (!chapter) {
            const saved = progressMap[book.book_id];
            chapter = (saved && book.chapters?.find(c => c.chapter_id === saved.chapterId)) || book.chapters?.[0] || null;
        }
        setCurrentChapter(chapter);
        if (chapter) {
            updateProgress(book.book_id, chapter);
            if (!chapter.content) loadChapterContent(chapter);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [route, booksLoaded, books]);

    // 当前会话作用域：按当前书隔离
    const scopeKey = currentBook?.book_id || '';

    const fetchSessions = useCallback(async (key) => {
        if (!key) { setSessions([]); return []; }
        try {
            const res = await fetch(`${API_BASE}/sessions?scope=book&book_id=${encodeURIComponent(key)}`);
            const data = await res.json();
            const list = data.sessions || [];
            setSessions(list);
            return list;
        } catch { return []; }
    }, []);

    // 切换书籍：重新拉会话列表，并自动恢复该书最近一次会话
    useEffect(() => {
        if (!scopeKey) { setSessionId(null); setMessages([]); setActiveExpertId(null); return; }
        let alive = true;
        (async () => {
            const list = await fetchSessions(scopeKey);
            if (!alive) return;
            if (list.length > 0) {
                try {
                    const res = await fetch(`${API_BASE}/sessions/${list[0].session_id}`);
                    const full = await res.json();
                    if (!alive) return;
                    setSessionId(full.session_id);
                    setMessages(full.messages || []);
                    setActiveExpertId(full.expert_id || null);
                    return;
                } catch { /* 落到空会话 */ }
            }
            if (alive) { setSessionId(null); setMessages([]); setActiveExpertId(null); }
        })();
        return () => { alive = false; };
    }, [scopeKey, fetchSessions]);

    // ---------- 书架 / 书内导航 ----------

    const handleEnterBook = (bookId, chapterId) => {
        pendingChapterRef.current = chapterId || null;
        window.location.hash = `#/book/${encodeURIComponent(bookId)}`;
    };

    const handleBackToShelf = () => {
        window.location.hash = '#/';
    };

    const updateProgress = useCallback((bookId, chapter) => {
        setProgressMap(prev => {
            const next = {
                ...prev,
                [bookId]: {
                    chapterId: chapter.chapter_id,
                    chapterTitle: chapter.title,
                    updatedAt: Date.now(),
                },
            };
            localStorage.setItem(PROGRESS_KEY, JSON.stringify(next));
            return next;
        });
    }, []);

    const handleSelectChapter = async (chapter) => {
        if (!chapter.content) {
            await loadChapterContent(chapter);
        } else {
            setCurrentChapter(chapter);
        }
        // 使用 chapter.book_id 而非闭包中的 currentBook（避免陈旧引用）
        if (chapter.book_id) {
            updateProgress(chapter.book_id, chapter);
        }
    };

    // 引用跳章的段落高亮目标（nonce 保证重复点同一处也能重新触发）
    const [citeTarget, setCiteTarget] = useState(null);

    // 从来源标注/引用芯片跳原文；v2.2 起带 snippet 时跳章后定位段落并闪烁高亮
    const handleNavigateToSource = async (bookId, chapterId, snippet) => {
        if (!bookId) return;
        setCiteTarget({ chapter_id: chapterId, snippet: snippet || '', nonce: Date.now() });
        const book = books.find(b => b.book_id === bookId);
        if (!book) return;
        if (currentBook?.book_id !== bookId) {
            handleEnterBook(bookId, chapterId);
            return;
        }
        const chapter = book.chapters?.find(c => c.chapter_id === chapterId);
        if (chapter) await handleSelectChapter(chapter);
    };

    // ---------- 上传 / 删除 ----------

    const handleDeleteBook = async (bookId) => {
        try {
            const res = await fetch(`${API_BASE}/books/${bookId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('删除失败');
            setBooks(prev => prev.filter(b => b.book_id !== bookId));
            if (currentBook?.book_id === bookId) {
                setCurrentBook(null);
                setCurrentChapter(null);
                setSessionId(null);
                setMessages([]);
                if (route.view === 'book') window.location.hash = '#/';
            }
        } catch (err) {
            console.error('删除失败:', err);
            alert(`删除失败: ${err.message}`);
        }
    };

    // 批量上传（上传 → 异步分析 → 轮询进度）；单任务串行，进行中直接忽略
    const uploadingRef = useRef(false);
    const handleUploadMultiple = async (files) => {
        if (uploadingRef.current || files.length === 0) return;
        uploadingRef.current = true;
        const total = files.length;
        setUploadProgress({ phase: 'uploading', current: 0, total });

        // Phase 1: 上传所有文件（快速）；后端按内容指纹去重，重复书不再进入分析队列
        const uploaded = [];
        const duplicates = [];
        for (let i = 0; i < files.length; i++) {
            setUploadProgress({ phase: 'uploading', current: i + 1, total });
            const file = files[i];
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await fetch(`${API_BASE}/books/upload`, { method: 'POST', body: formData });
                if (res.ok) {
                    const data = await res.json();
                    if (data.duplicate) {
                        duplicates.push(`《${data.existing_title || file.name}》`);
                    } else {
                        uploaded.push(data);
                    }
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert(`上传 ${file.name} 失败: ${err.detail || res.status}`);
                }
            } catch (err) {
                alert(`上传 ${file.name} 失败: ${err.message}`);
            }
        }

        if (duplicates.length > 0) {
            alert(`以下书籍已存在于书库（按内容识别），自动跳过：\n${duplicates.join('\n')}`);
        }

        if (uploaded.length === 0) { setUploadProgress(null); uploadingRef.current = false; return; }

        // Phase 2: 异步分析 + 轮询进度
        setUploadProgress({ phase: 'analyzing', current: 0, total: uploaded.length, ocrProgress: null });

        for (const item of uploaded) {
            fetch(`${API_BASE}/books/analyze/${item.book_id}`, { method: 'POST' }).catch(() => {});
        }

        const pollInterval = 2000;
        const maxWait = 600000; // 10分钟
        const startTime = Date.now();
        let completed = 0;

        while (completed < uploaded.length && Date.now() - startTime < maxWait) {
            await new Promise(r => setTimeout(r, pollInterval));

            const pending = uploaded.filter(item => !item._done);
            for (const item of pending) {
                try {
                    const res = await fetch(`${API_BASE}/books/status/${item.book_id}`);
                    const status = await res.json();
                    if (status.status === 'completed') {
                        completed++;
                        item._done = true;
                        const ar = await fetch(`${API_BASE}/books/analysis/${item.book_id}`);
                        if (ar.ok) {
                            const result = await ar.json();
                            setBooks(prev => [{ ...result, _new: true }, ...prev]);
                        }
                    } else if (status.status === 'failed') {
                        // 后端已明确失败，不必再等 10 分钟超时
                        completed++;
                        item._done = true;
                        alert(`《${item.filename}》解析失败: ${status.error || '未知原因'}`);
                    } else if (status.status === 'duplicate') {
                        // 分析阶段才发现内容重复（并发上传同本书的窄窗口）
                        completed++;
                        item._done = true;
                    } else if (status.ocr_progress) {
                        setUploadProgress(prev => ({
                            ...prev,
                            ocrProgress: status.ocr_progress,
                            ocrFilename: item.filename
                        }));
                    }
                } catch (e) { /* 继续轮询 */ }
            }
            setUploadProgress(prev => ({ ...prev, current: completed }));
        }

        setUploadProgress(null);
        uploadingRef.current = false;

        const failed = uploaded.filter(item => !item._done);
        if (failed.length > 0) {
            alert(`${failed.length} 本书分析超时，请稍后刷新书架查看`);
        }
    };

    // ---------- 会话与对话 ----------

    // 惰性创建会话：首次发言/跑工具才占坑，避免历史列表堆满空"新对话"
    const ensureSession = async () => {
        if (sessionId) return sessionId;
        if (!scopeKey) return null;
        try {
            const res = await fetch(`${API_BASE}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'book', book_id: currentBook?.book_id })
            });
            const sid = (await res.json()).session_id;
            setSessionId(sid);
            return sid;
        } catch { return null; }
    };

    // 上下文构造：最近 8 条；工具产出以截断摘录参与追问（HTML 产物只留一行占位说明）
    const buildHistory = () => messages
        .filter(m => !m.streaming)
        .slice(-8)
        .map(m => {
            if (m.kind === 'tool') {
                const name = m.tool_name || TOOL_LABELS[m.tool_id] || m.tool_id;
                if (m.output_type === 'html') {
                    return { role: 'assistant', content: `【AI 工具产出 · ${name}】已生成 HTML 精读笔记页` };
                }
                const text = (m.content || '').trim();
                if (!text) return null;
                // 思维导图 JSON 结构树截断无意义，给一行结构摘要（章数 + 有主题的章数）
                if (m.tool_id === 'mindmap' && text.startsWith('{')) {
                    let desc = '已生成思维导图结构树';
                    try {
                        const tree = JSON.parse(text);
                        const chs = tree.c || [];
                        const withThemes = chs.filter(n => (n.c || []).length > 0).length;
                        if (chs.length) desc = `已生成思维导图结构树（${chs.length} 章，其中 ${withThemes} 章已提炼主题）`;
                    } catch { /* 保持兜底描述 */ }
                    return { role: 'assistant', content: `【AI 工具产出 · ${name}】${desc}` };
                }
                const excerpt = text.length > 600 ? text.slice(0, 600) + '…（截断）' : text;
                return { role: 'assistant', content: `【AI 工具产出 · ${name}】\n${excerpt}` };
            }
            if (m.kind === 'opening' || m.kind === 'report' || !m.kind) {
                // v2.7 带划线引用的用户消息：把摘录前缀进历史，追问时模型知道「这段」指什么
                const content = m.quote?.text
                    ? `读者从书中摘录了一段${m.quote.chapter_title ? `（《${m.quote.chapter_title}》）` : ''}：「${m.quote.text}」\n\n${m.content}`
                    : m.content;
                return { role: m.role, content };
            }
            return null;
        })
        .filter(m => m && m.content && m.content.trim());

    // 流式发送消息（后端按 session_id 自动落盘，刷新不丢）；quote=v2.7 划线引用随消息附带
    const handleSendMessage = async (message, quote) => {
        if (!currentBook || isStreaming) return;
        setIsStreaming(true);
        setAiOpen(true);
        if (quote?.text) setQuoteDraft(null);

        const sid = await ensureSession();

        const body = {
            message,
            chat_history: buildHistory(),
            session_id: sid,
            book_id: currentBook?.book_id,
        };
        if (currentChapter?.chapter_id) body.chapter_id = currentChapter.chapter_id;
        if (activeExpertId) body.expert_id = activeExpertId;
        if (quote?.text) body.quote = { text: quote.text, chapter_id: quote.chapter_id || null };

        // 只发引用不问问题时，本地气泡文案与后端落盘的兜底提问保持一致
        const displayMessage = message || (quote?.text ? '请帮我解读这段摘录。' : '');
        setMessages(prev => [...prev,
            { role: 'user', content: displayMessage, quote: quote?.text ? quote : undefined },
            { role: 'assistant', content: '' }]);

        const patchLast = (patchFn) => setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = patchFn({ ...next[next.length - 1] });
            return next;
        });

        try {
            const response = await fetch(`${API_BASE}/analysis/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantMessage = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 半截行留到下个 chunk 再拼（SSE 帧可能被 TCP 切开）
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const json = JSON.parse(data);
                        if (json.content) {
                            assistantMessage += json.content;
                            patchLast(m => ({ ...m, content: assistantMessage }));
                        }
                        if (json.sources) {
                            patchLast(m => ({ ...m, sources: json.sources }));
                        }
                    } catch (e) { /* skip parse errors */ }
                }
            }
            if (sid) fetchSessions(scopeKey); // 刷新标题/排序
        } catch (err) {
            console.error('发送失败:', err);
            patchLast(m => ({ ...m, content: m.content || `发送失败: ${err.message}` }));
        } finally {
            setIsStreaming(false);
        }
    };

    // AI 工具：产出即消息（v2.0）——结果作为 kind=tool 消息流进当前对话末尾，完成后可被追问
    // scopeAll=true 时作用范围为整本书（chapter_id 不下发），否则为左栏当前选中章
    const handleRunTool = async (toolId, userInput, scopeAll, minutes) => {
        if (!currentBook || isStreaming || busyToolId) return;
        setAiOpen(true);
        setBusyToolId(toolId);

        const sid = await ensureSession();
        const toolName = TOOL_LABELS[toolId] || toolId;
        const scope = (userInput || '').trim() || (scopeAll || !currentChapter ? '整本书' : currentChapter.title);
        const tid = `${toolId}-${Date.now()}`;

        setMessages(prev => [...prev, {
            _tid: tid, role: 'assistant', kind: 'tool',
            tool_id: toolId, tool_name: toolName, output_type: 'text',
            content: '', scope, streaming: true,
        }]);

        const patchTool = (patchFn) => setMessages(prev => prev.map(m => m._tid === tid ? patchFn({ ...m }) : m));

        try {
            const res = await fetch(`${API_BASE}/api/tools/${toolId}/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    book_id: currentBook.book_id,
                    chapter_id: scopeAll ? null : (currentChapter?.chapter_id ?? null),
                    user_input: userInput || null,
                    minutes: minutes || null,
                })
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(errText || `请求失败 (${res.status})`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let text = '';
            let status = '';
            let sources = [];
            let artifact = null;
            let streamError = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6);
                    if (payload === '[DONE]') continue;
                    try {
                        const f = JSON.parse(payload);
                        if (f.status !== undefined) status = f.status;
                        else if (f.content !== undefined) text += f.content;
                        else if (f.sources) sources = f.sources;
                        else if (f.artifact) artifact = f.artifact;
                        else if (f.error) streamError = f.error;
                    } catch { /* 半截 JSON 丢弃即可，后续帧完整 */ }
                    patchTool(m => ({
                        ...m,
                        content: artifact ? m.content : text,
                        status: status || m.status,
                        sources: sources.length ? sources : m.sources,
                    }));
                }
            }

            const outputType = artifact ? (artifact.type === 'mindmap' ? 'mindmap' : artifact.type === 'cards' ? 'cards' : artifact.type === 'audio' ? 'audio' : 'html') : 'text';
            const finalContent = artifact ? artifact.data : text;

            if (streamError) {
                patchTool(m => ({ ...m, streaming: false, error: streamError }));
            } else {
                patchTool(m => ({
                    ...m, streaming: false, content: finalContent,
                    output_type: outputType, filename: artifact?.filename,
                }));
                // 抽卡产出即入库：刷新徽标（书架/书内顶栏的 due 数）
                if (toolId === 'cards') loadCardStats();
                // 落盘：产出即消息（刷新/切会话后仍在）
                if (sid && finalContent.trim()) {
                    fetch(`${API_BASE}/sessions/${sid}/messages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            role: 'assistant', content: finalContent, kind: 'tool',
                            tool_id: toolId, tool_name: toolName,
                            output_type: outputType, filename: artifact?.filename || null,
                            scope, sources: sources.length ? sources : null,
                        })
                    }).then(r => { if (!r.ok) console.warn('工具产出落盘失败', r.status); })
                      .catch(e => console.warn('工具产出落盘失败', e));
                    fetchSessions(scopeKey);
                }
            }
        } catch (err) {
            console.error('工具调用失败:', err);
            patchTool(m => ({ ...m, streaming: false, error: err.message }));
        } finally {
            setBusyToolId(null);
        }
    };

    // 会话操作
    const handleNewSession = () => {
        setSessionId(null);
        setMessages([]);
        setActiveExpertId(null);
        setQuoteDraft(null);
        setAiOpen(true);
    };

    const handleSelectSession = async (id) => {
        if (id === sessionId) return;
        try {
            const res = await fetch(`${API_BASE}/sessions/${id}`);
            const full = await res.json();
            setSessionId(full.session_id);
            setMessages(full.messages || []);
            setActiveExpertId(full.expert_id || null);
            setQuoteDraft(null);
            setAiOpen(true);
        } catch (err) {
            console.error('加载会话失败:', err);
        }
    };

    const handleDeleteSession = async (id) => {
        try {
            await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
            if (id === sessionId) { setSessionId(null); setMessages([]); setActiveExpertId(null); setQuoteDraft(null); }
            fetchSessions(scopeKey);
        } catch (err) {
            console.error('删除会话失败:', err);
        }
    };

    // 专家模式：进入 = 生成起手式并建会话（范围 = 当前选中章，未选中则整本书）
    const handleOpenExpert = async (expertId) => {
        if (!currentBook || expertOpening) return;
        setExpertOpening(true);
        setAiOpen(true);
        try {
            const res = await fetch(`${API_BASE}/experts/${expertId}/opening`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    book_id: currentBook.book_id,
                    chapter_id: currentChapter?.chapter_id
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `启动失败 (${res.status})`);
            }
            const data = await res.json();
            setSessionId(data.session_id);
            setMessages([{ role: 'assistant', content: data.content, kind: 'opening' }]);
            setActiveExpertId(expertId);
            fetchSessions(scopeKey);
        } catch (err) {
            console.error('专家模式启动失败:', err);
            alert(`专家模式启动失败: ${err.message}`);
        } finally {
            setExpertOpening(false);
        }
    };

    // 收束报告：基于会话全程流式生成专家诊断（后端完成后落盘 kind=report）
    const handleGenerateReport = async () => {
        if (!activeExpertId || !sessionId || isStreaming) return;
        setIsStreaming(true);
        setAiOpen(true);
        setMessages(prev => [...prev, { role: 'assistant', content: '', kind: 'report' }]);
        let text = '';
        try {
            const res = await fetch(`${API_BASE}/experts/${activeExpertId}/report`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `生成失败 (${res.status})`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6);
                    if (payload === '[DONE]') continue;
                    let f = null;
                    try { f = JSON.parse(payload); } catch { /* 半截 JSON 丢弃 */ }
                    if (f && f.content !== undefined) {
                        text += f.content;
                        setMessages(prev => {
                            const next = [...prev];
                            next[next.length - 1] = { ...next[next.length - 1], content: text };
                            return next;
                        });
                    }
                }
            }
        } catch (err) {
            console.error('收束报告生成失败:', err);
            setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { ...next[next.length - 1], content: `收束报告生成失败: ${err.message}` };
                return next;
            });
        } finally {
            setIsStreaming(false);
            fetchSessions(scopeKey);
        }
    };

    // 收藏 toggle → 后端资产（v2.4）。匹配：tool 按 toolId+内容，其余按标题+内容
    // （title 后端截 200 字，比对用同长前缀避免截断误判重复收藏）
    const handleToggleFavorite = async (qa) => {
        const bookId = currentBook?.book_id;
        if (!bookId) return;
        const isSame = (f) => f.type === qa.type && (f.answer || '') === (qa.answer || '')
            && (qa.type === 'tool' ? f.toolId === qa.toolId
                : (f.question || '').slice(0, 200) === (qa.question || '').slice(0, 200));
        const existing = favorites.find(isSame);
        if (existing) {
            setFavorites(prev => prev.filter(f => f.id !== existing.id));
            fetch(`${API_BASE}/assets/${existing.id}`, { method: 'DELETE' })
                .catch(() => loadAssets(bookId));
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(favToApi(qa, bookId)),
            });
            if (!res.ok) return;
            const { asset } = await res.json();
            setFavorites(prev => [apiToFav(asset), ...prev]);
        } catch { /* 网络失败不落脏状态 */ }
    };

    const handleRemoveFavorite = (id) => {
        const bookId = currentBook?.book_id;
        setFavorites(prev => prev.filter(f => f.id !== id));
        fetch(`${API_BASE}/assets/${id}`, { method: 'DELETE' })
            .catch(() => { if (bookId) loadAssets(bookId); });
    };

    const activeExpert = experts.find(e => e.expert_id === activeExpertId) || null;

    if (route.view === 'review') {
        return (
            <ReviewPage
                books={books}
                onBack={() => { window.location.hash = '#/'; }}
                onStatsChanged={loadCardStats}
            />
        );
    }

    if (route.view === 'book' && currentBook) {
        return (
            <BookReader
                currentBook={currentBook}
                currentChapter={currentChapter}
                onSelectChapter={handleSelectChapter}
                onBackToShelf={handleBackToShelf}
                citeTarget={citeTarget}
                sessions={sessions}
                currentSessionId={sessionId}
                onNewSession={handleNewSession}
                onSelectSession={handleSelectSession}
                onDeleteSession={handleDeleteSession}
                messages={messages}
                isStreaming={isStreaming}
                busyToolId={busyToolId}
                onSendMessage={handleSendMessage}
                onRunTool={handleRunTool}
                favorites={favorites}
                onToggleFavorite={handleToggleFavorite}
                onRemoveFavorite={handleRemoveFavorite}
                onNavigateToSource={handleNavigateToSource}
                experts={experts}
                activeExpert={activeExpert}
                expertOpening={expertOpening}
                onOpenExpert={handleOpenExpert}
                onGenerateReport={handleGenerateReport}
                aiOpen={aiOpen}
                setAiOpen={setAiOpen}
                cardDue={(cardStats.stats[currentBook?.book_id] || {}).due || 0}
                onCardsStatsChanged={loadCardStats}
                highlights={highlights}
                onAddHighlights={handleAddHighlights}
                onRemoveHighlight={handleRemoveHighlight}
                onQuoteToChat={setQuoteDraft}
                quoteDraft={quoteDraft}
                onClearQuote={() => setQuoteDraft(null)}
            />
        );
    }

    // 书内但书还没就位（深链加载中）时保持空白，避免书架闪现
    if (route.view === 'book') {
        return <div className="h-screen bg-zinc-50" />;
    }

    return (
        <Bookshelf
            books={books}
            progressMap={progressMap}
            uploading={uploadProgress}
            cardDue={cardStats.due}
            onOpenReview={() => { window.location.hash = '#/review'; }}
            onEnterBook={handleEnterBook}
            onUploadMultiple={handleUploadMultiple}
            onDeleteBook={handleDeleteBook}
        />
    );
}

export default App;
