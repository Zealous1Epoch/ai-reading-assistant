import { useState, useEffect, useRef, useCallback } from 'react';
import LeftPanel from './components/LeftPanel.jsx';
import MiddlePanel from './components/MiddlePanel.jsx';
import RightPanel from './components/RightPanel.jsx';

const API_BASE = '';

function App() {
    const [books, setBooks] = useState([]);
    const [currentBook, setCurrentBook] = useState(null);
    const [currentChapter, setCurrentChapter] = useState(null);
    const [uploadProgress, setUploadProgress] = useState(null); // { current, total } or null
    const [messages, setMessages] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [sessionId, setSessionId] = useState(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [contentMode, setContentMode] = useState('book');
    const [activeTool, setActiveTool] = useState(null);
    const [toolLoading, setToolLoading] = useState(false);
    const [toolResult, setToolResult] = useState(null);
    const [chatMode, setChatMode] = useState('book');
    const [sources, setSources] = useState(null);
    const [selectedBookIds, setSelectedBookIds] = useState([]);
    const [favorites, setFavorites] = useState(() => {
        try { return JSON.parse(localStorage.getItem('reading_favorites') || '[]'); }
        catch { return []; }
    });

    // 收藏持久化
    useEffect(() => {
        localStorage.setItem('reading_favorites', JSON.stringify(favorites));
    }, [favorites]);

    // 页面加载时从后端恢复书籍列表
    useEffect(() => {
        fetch(`${API_BASE}/books/list`)
            .then(res => res.json())
            .then(data => {
                if (data.books?.length > 0) {
                    setBooks(data.books);
                    const saved = (() => { try { return JSON.parse(localStorage.getItem('reading_progress')); } catch { return null; } })();
                    if (saved?.bookId) {
                        const book = data.books.find(b => b.book_id === saved.bookId);
                        if (book) {
                            setCurrentBook(book);
                            const chapter = book.chapters?.find(c => c.chapter_id === saved.chapterId);
                            setCurrentChapter(chapter || book.chapters?.[0] || null);
                            return;
                        }
                    }
                    setCurrentBook(data.books[0]);
                    setCurrentChapter(data.books[0].chapters?.[0] || null);
                }
            })
            .catch(err => console.log('获取书籍列表失败（首次加载无数据是正常的）:', err));
    }, []);

    // 当前会话作用域：单书模式按书隔离，对比阅读全局一个桶
    const scopeKey = chatMode === 'cross' ? 'cross' : (currentBook?.book_id || '');
    const scopeRef = useRef(scopeKey);

    const fetchSessions = useCallback(async (key) => {
        if (!key) { setSessions([]); return []; }
        try {
            const params = chatMode === 'cross' ? 'scope=cross' : `scope=book&book_id=${encodeURIComponent(key)}`;
            const res = await fetch(`${API_BASE}/sessions?${params}`);
            const data = await res.json();
            const list = data.sessions || [];
            setSessions(list);
            return list;
        } catch { return []; }
    }, [chatMode]);

    // 切换书/模式：重新拉会话列表，并自动恢复该作用域最近一次会话
    useEffect(() => {
        scopeRef.current = scopeKey;
        setSources(null);
        if (!scopeKey) { setSessionId(null); setMessages([]); return; }
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
                    return;
                } catch { /* 落到空会话 */ }
            }
            if (alive) { setSessionId(null); setMessages([]); }
        })();
        return () => { alive = false; };
    }, [scopeKey, fetchSessions]);

    const handleToggleBook = (bookId) => {
        setSelectedBookIds(prev =>
            prev.includes(bookId)
                ? prev.filter(id => id !== bookId)
                : [...prev, bookId]
        );
    };

    const resetSession = () => {
        setContentMode('book');
        setActiveTool(null);
        setToolResult(null);
    };

    // 删除书籍
    const handleDeleteBook = async (bookId) => {
        try {
            const res = await fetch(`${API_BASE}/books/${bookId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('删除失败');
            // 使用函数式更新，确保基于最新状态计算
            if (currentBook?.book_id === bookId) {
                setBooks(prev => {
                    const remaining = prev.filter(b => b.book_id !== bookId);
                    setCurrentBook(remaining[0] || null);
                    setCurrentChapter(null);
                    return remaining;
                });
                setSessionId(null);
                setMessages([]);
            } else {
                setBooks(prev => prev.filter(b => b.book_id !== bookId));
            }
            setSessions([]);
        } catch (err) {
            console.error('删除失败:', err);
            alert(`删除失败: ${err.message}`);
        }
    };

    // 批量上传（上传 → 异步分析 → 轮询进度）
    const handleUploadMultiple = async (files) => {
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

        if (uploaded.length === 0) { setUploadProgress(null); return; }

        // Phase 2: 异步分析 + 轮询进度
        setUploadProgress({ phase: 'analyzing', current: 0, total: uploaded.length, ocrProgress: null });

        // 启动所有异步分析
        for (const item of uploaded) {
            fetch(`${API_BASE}/books/analyze/${item.book_id}`, { method: 'POST' }).catch(() => {});
        }

        // 轮询状态
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
                        // 获取分析结果
                        const ar = await fetch(`${API_BASE}/books/analysis/${item.book_id}`);
                        if (ar.ok) {
                            const result = await ar.json();
                            setBooks(prev => [{ ...result, _new: true }, ...prev]);
                            if (!currentBook) {
                                setCurrentBook(result);
                                setCurrentChapter(result.chapters?.[0] || null);
                            }
                        }
                    } else if (status.status === 'failed') {
                        // 后端已明确失败，不必再等 10 分钟超时
                        completed++;
                        item._done = true;
                        item._failed = true;
                        setToolResult({ error: `《${item.filename}》解析失败: ${status.error || '未知原因'}` });
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

        // 检查是否有未完成的文件
        const failed = uploaded.filter(item => !item._done);
        if (failed.length > 0) {
            setToolResult({ error: `${failed.length} 本书分析超时，请稍后重试` });
        }
    };

    // 上传书籍（单文件，兼容旧接口）
    const handleUploadBook = (file) => handleUploadMultiple([file]);

    // 选择书籍（不重置聊天记录）
    const handleSelectBook = async (book) => {
        setCurrentBook(book);
        setCurrentChapter(book.chapters?.[0] || null);
        setContentMode('book');
        setActiveTool(null);
        setToolResult(null);
        if (book.chapters?.[0] && !book.chapters[0].content) {
            await loadChapterContent(book.chapters[0]);
        }
    };

    // 用于处理竞态条件：追踪当前正在加载的章节 ID
    const loadingChapterRef = useRef(null);

    // 加载章节内容（处理竞态条件）
    const loadChapterContent = async (chapter) => {
        const chapterId = chapter.chapter_id;
        loadingChapterRef.current = chapterId;
        try {
            const res = await fetch(`${API_BASE}/books/chapters/${chapterId}`);
            const data = await res.json();
            // 仅当返回的章节仍是当前选中的章节时更新状态（防止竞态）
            if (loadingChapterRef.current === chapterId) {
                setCurrentChapter(data);
            }
        } catch (err) {
            console.error('获取章节失败:', err);
        }
    };

    const handleSelectChapter = async (chapter) => {
        if (!chapter.content) {
            await loadChapterContent(chapter);
        } else {
            setCurrentChapter(chapter);
        }
        // 使用 chapter.book_id 而非闭包中的 currentBook（避免陈旧引用）
        if (chapter.book_id) {
            localStorage.setItem('reading_progress', JSON.stringify({ bookId: chapter.book_id, chapterId: chapter.chapter_id }));
        }
    };

    // 从来源标注跳转到原文
    const handleNavigateToSource = async (bookId, chapterId) => {
        const book = books.find(b => b.book_id === bookId);
        if (!book) return;
        setCurrentBook(book);
        setContentMode('book');
        setActiveTool(null);
        setToolResult(null);
        const chapter = book.chapters?.find(c => c.chapter_id === chapterId);
        if (chapter) {
            if (!chapter.content) {
                await loadChapterContent(chapter);
            } else {
                setCurrentChapter(chapter);
            }
        }
    };

    // 流式发送消息（后端按 session_id 自动落盘，刷新不丢）
    const handleSendMessage = async (message) => {
        setIsStreaming(true);
        setSources(null);

        // 惰性创建会话：首次提问才占坑，避免历史列表堆满空"新对话"
        let sid = sessionId;
        if (!sid && scopeKey) {
            try {
                const res = await fetch(`${API_BASE}/sessions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        scope: chatMode,
                        book_id: chatMode === 'book' ? currentBook?.book_id : null
                    })
                });
                sid = (await res.json()).session_id;
                setSessionId(sid);
            } catch { sid = null; }
        }

        const history = messages.slice(-6).map(({ role, content }) => ({ role, content }));
        const body = { message, chat_history: history, session_id: sid };
        if (chatMode === 'book') {
            body.book_id = currentBook?.book_id;
            if (currentChapter?.chapter_id) {
                body.chapter_id = currentChapter.chapter_id;
            }
        } else {
            body.selected_book_ids = selectedBookIds.length > 0 ? selectedBookIds : null;
        }

        setMessages(prev => [...prev, { role: 'user', content: message }, { role: 'assistant', content: '' }]);

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
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;
                        try {
                            const json = JSON.parse(data);
                            if (json.content) {
                                assistantMessage += json.content;
                                setMessages(prev => {
                                    const newMessages = [...prev];
                                    newMessages[newMessages.length - 1].content = assistantMessage;
                                    return newMessages;
                                });
                            }
                            if (json.sources) {
                                setSources(json.sources);
                            }
                        } catch (e) { /* skip parse errors */ }
                    }
                }
            }
            if (sid) fetchSessions(scopeKey); // 刷新标题/排序
        } catch (err) {
            console.error('发送失败:', err);
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant' && !last.content) {
                    const next = [...prev];
                    next[next.length - 1] = { role: 'assistant', content: `发送失败: ${err.message}` };
                    return next;
                }
                return [...prev, { role: 'assistant', content: `发送失败: ${err.message}` }];
            });
        } finally {
            setIsStreaming(false);
        }
    };

    // 会话操作
    const handleNewSession = () => {
        setSessionId(null);
        setMessages([]);
        setSources(null);
    };

    const handleSelectSession = async (id) => {
        if (id === sessionId) return;
        try {
            const res = await fetch(`${API_BASE}/sessions/${id}`);
            const full = await res.json();
            setSessionId(full.session_id);
            setMessages(full.messages || []);
            setSources(null);
        } catch (err) {
            console.error('加载会话失败:', err);
        }
    };

    const handleDeleteSession = async (id) => {
        try {
            await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
            if (id === sessionId) { setSessionId(null); setMessages([]); setSources(null); }
            fetchSessions(scopeKey);
        } catch (err) {
            console.error('删除会话失败:', err);
        }
    };

    // 工具卡片点击 —— SSE 流式；作用范围 = 左栏当前选中章（未选中则整本书）
    const handleRunTool = async (toolId, userInput) => {
        if (!currentBook || toolLoading) return;

        setActiveTool(toolId);
        setToolLoading(true);
        setToolResult({ data: '', streaming: true });

        try {
            const res = await fetch(`${API_BASE}/api/tools/${toolId}/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    book_id: currentBook.book_id,
                    chapter_id: currentChapter?.chapter_id,
                    user_input: userInput || null
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
                    setToolResult({
                        data: text, streaming: true,
                        status: status || undefined,
                        sources: sources.length ? sources : undefined,
                    });
                }
            }

            if (streamError) setToolResult({ error: streamError });
            else if (artifact) setToolResult({ type: 'html', data: artifact.data, filename: artifact.filename });
            else setToolResult({ data: text, sources: sources.length ? sources : undefined });
        } catch (err) {
            console.error('工具调用失败:', err);
            setToolResult({ error: err.message });
        } finally {
            setToolLoading(false);
        }
    };

    const handleBackToTools = () => {
        setActiveTool(null);
        setToolResult(null);
    };

    const handleToggleMode = (mode) => {
        setChatMode(mode);
    };

    const handleBackToBook = () => {
        setContentMode('book');
    };

    // 收藏（按内容去重，持久化到 localStorage）
    const handleToggleFavorite = (qa) => {
        setFavorites(prev => {
            const existing = prev.find(f => f.question === qa.question && f.answer === qa.answer);
            if (existing) return prev.filter(f => f.id !== existing.id);
            const entry = { ...qa, id: 'fav-' + Date.now(), savedAt: new Date().toLocaleString() };
            return [entry, ...prev];
        });
    };

    const handleRemoveFavorite = (id) => {
        setFavorites(prev => prev.filter(f => f.id !== id));
    };

    const getActiveMessages = () => messages;

    return (
        <div className="h-screen flex overflow-hidden bg-zinc-50 p-3 gap-3">
            <LeftPanel
                books={books}
                currentBook={currentBook}
                currentChapter={currentChapter}
                selectedBookIds={selectedBookIds}
                onToggleBook={handleToggleBook}
                onSelectBook={handleSelectBook}
                onSelectChapter={handleSelectChapter}
                onUploadBook={handleUploadBook}
                onUploadMultiple={handleUploadMultiple}
                onDeleteBook={handleDeleteBook}
                uploading={uploadProgress}
                chatMode={chatMode}
            />
            <MiddlePanel
                currentBook={currentBook}
                currentChapter={currentChapter}
                chatMessages={getActiveMessages()}
                sessions={sessions}
                currentSessionId={sessionId}
                onNewSession={handleNewSession}
                onSelectSession={handleSelectSession}
                onDeleteSession={handleDeleteSession}
                isStreaming={isStreaming}
                onSendMessage={handleSendMessage}
                chatMode={chatMode}
                onToggleMode={handleToggleMode}
                sources={sources}
                selectedBookIds={selectedBookIds}
                books={books}
                onToggleFavorite={handleToggleFavorite}
                onNavigateToSource={handleNavigateToSource}
                favorites={favorites}
            />
            <RightPanel
                currentBook={currentBook}
                currentChapter={currentChapter}
                toolState={{ toolId: activeTool, loading: toolLoading, result: toolResult }}
                onRunTool={handleRunTool}
                onBackToTools={handleBackToTools}
                favorites={favorites}
                onToggleFavorite={handleToggleFavorite}
                onRemoveFavorite={handleRemoveFavorite}
            />
        </div>
    );
}

export default App;
