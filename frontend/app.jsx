const { useState, useEffect, useRef, useCallback } = React;

const API_BASE = '';

function App() {
    const [books, setBooks] = useState([]);
    const [currentBook, setCurrentBook] = useState(null);
    const [currentChapter, setCurrentChapter] = useState(null);
    const [uploadProgress, setUploadProgress] = useState(null); // { current, total } or null
    const [bookChats, setBookChats] = useState({});
    const [crossBookMessages, setCrossBookMessages] = useState([]);
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

    const getMessages = () => {
        if (chatMode === 'cross') return { msgs: crossBookMessages, setMsgs: setCrossBookMessages };
        const bookId = currentBook?.book_id;
        const msgs = bookChats[bookId] || [];
        const setMsgs = (updater) => {
            setBookChats(prev => ({ ...prev, [bookId]: typeof updater === 'function' ? updater(prev[bookId] || []) : updater }));
        };
        return { msgs, setMsgs };
    };

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
            setBooks(prev => prev.filter(b => b.book_id !== bookId));
            setBookChats(prev => { const next = { ...prev }; delete next[bookId]; return next; });
            if (currentBook?.book_id === bookId) {
                setCurrentBook(books.find(b => b.book_id !== bookId) || null);
                setCurrentChapter(null);
            }
        } catch (err) {
            console.error('删除失败:', err);
            alert(`删除失败: ${err.message}`);
        }
    };

    // 批量上传（上传 → 异步分析 → 轮询进度）
    const handleUploadMultiple = async (files) => {
        const total = files.length;
        setUploadProgress({ phase: 'uploading', current: 0, total });

        // Phase 1: 上传所有文件（快速）
        const uploaded = [];
        for (let i = 0; i < files.length; i++) {
            setUploadProgress({ phase: 'uploading', current: i + 1, total });
            const file = files[i];
            const formData = new FormData();
            formData.append('file', file);
            try {
                const res = await fetch(`${API_BASE}/books/upload`, { method: 'POST', body: formData });
                if (res.ok) {
                    const data = await res.json();
                    uploaded.push(data);
                }
            } catch (err) {
                alert(`上传 ${file.name} 失败: ${err.message}`);
            }
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

    // 加载章节内容
    const loadChapterContent = async (chapter) => {
        try {
            const res = await fetch(`${API_BASE}/books/chapters/${chapter.chapter_id}`);
            const data = await res.json();
            setCurrentChapter(data);
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
        if (currentBook?.book_id) {
            localStorage.setItem('reading_progress', JSON.stringify({ bookId: currentBook.book_id, chapterId: chapter.chapter_id }));
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

    // 流式发送消息
    const handleSendMessage = async (message) => {
        const { msgs, setMsgs } = getMessages();

        setMsgs(prev => [...prev, { role: 'user', content: message }]);
        setIsStreaming(true);
        setSources(null);

        try {
            const history = msgs.length > 0 ? msgs.slice(-6) : [];
            const body = { message, chat_history: history };
            if (chatMode === 'book') {
                body.book_id = currentBook?.book_id;
                if (currentChapter?.chapter_id) {
                    body.chapter_id = currentChapter.chapter_id;
                }
            } else {
                body.selected_book_ids = selectedBookIds.length > 0 ? selectedBookIds : null;
            }

            const response = await fetch(`${API_BASE}/analysis/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantMessage = '';

            setMsgs(prev => [...prev, { role: 'assistant', content: '' }]);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') break;
                        try {
                            const json = JSON.parse(data);
                            if (json.content) {
                                assistantMessage += json.content;
                                setMsgs(prev => {
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
        } catch (err) {
            console.error('发送失败:', err);
            setMsgs(prev => [...prev, { role: 'assistant', content: `发送失败: ${err.message}` }]);
        } finally {
            setIsStreaming(false);
        }
    };

    // 工具卡片点击
    const handleRunTool = async (toolId, userInput) => {
        if (!currentBook || toolLoading) return;

        setActiveTool(toolId);
        setToolLoading(true);

        try {
            const res = await fetch(`${API_BASE}/api/tools/${toolId}`, {
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

            const data = await res.json();
            setToolResult(data);
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

    const getActiveMessages = () => getMessages().msgs;

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

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
