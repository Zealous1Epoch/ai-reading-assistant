// 清理 AI 回复中的 Markdown 符号
function cleanMarkdown(text) {
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^---+\s*$/gm, '')
        .replace(/^>\s+/gm, '')
        .trim();
}

function MiddlePanel({ currentBook, currentChapter, chapters, chatMessages, isStreaming, onSendMessage, chatMode, onToggleMode, sources, selectedBookIds, books, onToggleFavorite, onNavigateToSource, favorites }) {
    const [input, setInput] = useState('');
    const [chapterSummary, setChapterSummary] = useState(null);
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [expandedChapter, setExpandedChapter] = useState(false);
    const chatEndRef = useRef(null);

    // 渲染内联引用：将「《书名》·章节名」格式渲染为小 badge
    function renderWithCitations(text) {
        const parts = text.split(/(「[^」]+」)/g);
        if (parts.length === 1) return text;
        return parts.map((part, i) => {
            const match = part.match(/「([^」]+)」/);
            if (match) {
                const [bookPart, chapterPart] = match[1].split('·');
                return React.createElement('span', {
                    key: i,
                    className: 'inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 bg-zinc-50 text-zinc-600 rounded text-xs font-medium border border-zinc-200'
                }, bookPart, chapterPart ? React.createElement('span', { className: 'text-zinc-300' }, '·') : null, chapterPart || null);
            }
            return part;
        });
    }

    // 选中章节时加载摘要
    useEffect(() => {
        if (currentChapter?.chapter_id) {
            setSummaryLoading(true);
            setExpandedChapter(false);
            setChapterSummary(null);

            fetch(`${API_BASE}/analysis/chapter/${currentChapter.chapter_id}/summary`)
                .then(res => res.json())
                .then(data => {
                    if (data.summary) {
                        setChapterSummary(data);
                    }
                    setSummaryLoading(false);
                })
                .catch(() => setSummaryLoading(false));
        }
    }, [currentChapter?.chapter_id]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    const handleSend = () => {
        if (!input.trim() || isStreaming) return;
        if (chatMode === 'cross' && selectedBookIds?.length === 0) return;
        onSendMessage(input.trim());
        setInput('');
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="flex-1 flex flex-col h-full min-w-0 bg-white rounded-3xl border border-zinc-200 overflow-hidden">
            {/* 顶部栏 */}
            <div className="h-14 px-6 border-b border-zinc-100 flex items-center gap-3 flex-shrink-0">
                {chatMode === 'cross' ? (
                    <>
                        <h1 className="text-base font-serif-heading font-semibold text-zinc-800">
                            <span className="flex items-center gap-2">
                                综合阅读
                            </span>
                        </h1>
                        {selectedBookIds?.length > 0 && (
                            <div className="ml-auto flex gap-1">
                                {selectedBookIds.map(id => {
                                    const book = books.find(b => b.book_id === id);
                                    return book ? (
                                        <span key={id} className="text-[11px] px-2 py-0.5 bg-zinc-50 text-zinc-500 rounded-full border border-zinc-200">
                                            {book.title}
                                        </span>
                                    ) : null;
                                })}
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <h1 className="text-base font-serif-heading font-semibold text-zinc-800 truncate">
                            {currentBook ? (
                                <span className="flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-800 flex-shrink-0"></span>
                                    {currentBook.title}
                                </span>
                            ) : '智能读书助手'}
                        </h1>
                        {currentChapter && (
                            <div className="ml-auto text-xs text-zinc-400">
                                {currentChapter.title}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto scrollbar-thin px-8 py-6">
                {!currentBook ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="text-center max-w-sm">
                            <div className="w-16 h-16 mx-auto mb-4 bg-zinc-50 rounded-3xl flex items-center justify-center">
                                <svg className="w-8 h-8 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                </svg>
                            </div>
                            <h3 className="text-base font-serif-heading font-semibold text-zinc-700 mb-1">选择一本书开始阅读</h3>
                            <p className="text-sm text-zinc-400">从左侧上传或选择书籍，AI 将帮你深入理解内容</p>
                        </div>
                    </div>
                ) : chatMode === 'cross' ? (
                    <div className="animate-fade-in max-w-3xl">
                        {/* 综合阅读头部 */}
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">综合阅读</span>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                {selectedBookIds.length > 0 ? (
                                    <>
                                        <span className="text-xs text-zinc-400">已选书籍：</span>
                                        {selectedBookIds.map(id => {
                                            const book = books.find(b => b.book_id === id);
                                            return book ? (
                                                <span key={id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium
                                                    bg-zinc-50 text-zinc-600 border border-zinc-200">
                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                    </svg>
                                                    {book.title}
                                                </span>
                                            ) : null;
                                        })}
                                    </>
                                ) : (
                                    <div className="flex items-center gap-2 bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3">
                                        <svg className="w-4 h-4 text-zinc-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                        </svg>
                                        <p className="text-sm text-zinc-500"></p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* 综合阅读快捷提示 */}
                        <div className="bg-zinc-50 rounded-2xl p-6 border border-zinc-200">
                            <h3 className="text-sm font-semibold text-zinc-800 mb-2">多书对比阅读</h3>
                            <p className="text-sm text-zinc-500 leading-relaxed">
                                你已开启综合阅读模式。在左侧勾选多本书后，可以直接提问，AI 会基于所选书籍的内容进行对比分析。
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
                                <span className="px-2.5 py-1 bg-white rounded-full border border-zinc-200">对比两本书对同一观点的看法</span>
                                <span className="px-2.5 py-1 bg-white rounded-full border border-zinc-200">分析不同作者的论证逻辑</span>
                                <span className="px-2.5 py-1 bg-white rounded-full border border-zinc-200">综合多本书的视角回答问题</span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="animate-fade-in max-w-3xl">
                        {currentChapter ? (
                            <div className="border border-zinc-200 rounded-3xl bg-white">
                                {/* 卡片头部：章节标题 */}
                                <div className="px-6 pt-5 pb-3 border-b border-zinc-50">
                                    <div className="flex items-center gap-2 text-xs text-zinc-400 mb-2">
                                        <span className="text-zinc-400">{currentBook.title}</span>
                                        {currentChapter.word_count && (
                                            <>
                                                <span className="text-zinc-200">·</span>
                                                <span>{currentChapter.word_count} 字</span>
                                            </>
                                        )}
                                    </div>
                                    <h2 className="text-lg font-serif-heading font-semibold text-zinc-900">
                                        {currentChapter.title}
                                    </h2>
                                </div>

                                {/* 摘要区 */}
                                <div className="px-6 py-4">
                                    {summaryLoading ? (
                                        <div className="flex items-center gap-2 text-zinc-400 text-sm py-3">
                                            <div className="animate-spin h-4 w-4 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                                            正在生成摘要...
                                        </div>
                                    ) : chapterSummary?.summary ? (
                                        <>
                                            <div className="bg-zinc-50 rounded-xl p-4 mb-3">
                                                <p className="text-sm text-zinc-600 leading-relaxed">
                                                    {chapterSummary.summary}
                                                </p>
                                            </div>
                                            {chapterSummary.keywords?.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {chapterSummary.keywords.map((kw, i) => (
                                                        <span key={i} className="text-xs px-2.5 py-1 rounded-full
                                                            bg-white text-zinc-500 border border-zinc-200">
                                                            {kw}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </>
                                    ) : null}
                                </div>

                                {/* 展开/收起全文 */}
                                <div className="px-6 pb-5">
                                    {currentChapter.content ? (
                                        <>
                                            <button
                                                onClick={() => setExpandedChapter(!expandedChapter)}
                                                className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 transition-colors"
                                            >
                                                {expandedChapter ? '收起全文' : '展开全文'}
                                                <svg className={`w-3.5 h-3.5 transition-transform ${expandedChapter ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                                </svg>
                                            </button>
                                            {expandedChapter && (
                                                <div className="mt-4 pt-4 border-t border-zinc-100 text-[15px] text-zinc-700 leading-[1.8] whitespace-pre-wrap">
                                                    {currentChapter.content.replace(/\n{3,}/g, '\n\n')}
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-xs text-zinc-400">暂无章节内容</p>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="text-zinc-400 text-sm py-8">该书籍暂无内容</div>
                        )}

                        {/* 书籍概要信息 */}
                        {currentBook?.summary && (
                            <div className="mt-6 bg-zinc-50 rounded-xl p-5">
                                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">书籍摘要</h3>
                                <p className="text-sm text-zinc-600 leading-relaxed">{currentBook.summary}</p>
                            </div>
                        )}
                    </div>
                )}

                {/* 对话消息 */}
                {chatMessages.length > 0 && (
                    <div className="mt-8 max-w-3xl border-t border-zinc-100 pt-6 space-y-4">
                        {chatMessages.map((msg, i) => (
                            <div key={i} className={`message-enter flex gap-2 items-start ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[80%] px-4 py-2.5 ${
                                    msg.role === 'user'
                                        ? 'bg-zinc-100 text-zinc-700 rounded-2xl rounded-br-md'
                                        : 'bg-white text-zinc-700 rounded-2xl rounded-bl-md border border-zinc-100'
                                }`}>
                                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.role === 'user' ? msg.content : renderWithCitations(cleanMarkdown(msg.content))}</p>
                                </div>
                            {msg.role === 'assistant' && chatMessages[i - 1]?.role === 'user' && (
                                    (() => {
                                        const alreadyFav = favorites?.some(f => f.question === chatMessages[i - 1].content && f.answer === msg.content);
                                        return (
                                            <button
                                                onClick={() => onToggleFavorite({
                                                    question: chatMessages[i - 1].content,
                                                    answer: msg.content
                                                })}
                                                className={`p-1.5 rounded-lg transition-all flex-shrink-0 mt-1 ${
                                                    alreadyFav
                                                        ? 'text-zinc-500 bg-zinc-50'
                                                        : 'text-zinc-300 hover:text-zinc-500 hover:bg-zinc-50'
                                                }`}
                                                title={alreadyFav ? '取消收藏' : '收藏此问答'}
                                            >
                                                <svg className="w-4 h-4" fill={alreadyFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                                                </svg>
                                            </button>
                                        );
                                    })()
                                )}
                            </div>
                        ))}
                        {isStreaming && (
                            <div className="flex justify-start">
                                <div className="bg-zinc-100 rounded-2xl rounded-bl-md px-4 py-3">
                                    <div className="flex gap-1">
                                        <span className="typing-dot w-2 h-2 bg-zinc-300 rounded-full"></span>
                                        <span className="typing-dot w-2 h-2 bg-zinc-300 rounded-full"></span>
                                        <span className="typing-dot w-2 h-2 bg-zinc-300 rounded-full"></span>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>
                )}

                {/* 来源标注 */}
                {sources?.length > 0 && chatMessages.length > 0 && (
                    <div className="mt-6 max-w-3xl">
                        <div className="flex items-center gap-2 mb-2">
                            <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">参考来源</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {sources.map((s, i) => (
                                <button key={i} onClick={() => onNavigateToSource?.(s.book_id, s.chapter_id)} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white text-zinc-600 rounded-full text-xs font-medium border border-zinc-200 cursor-pointer hover:bg-zinc-50 transition-all">
                                    <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                    </svg>
                                    <span className="font-semibold">{s.book_title || '未知书名'}</span>
                                    <span className="text-zinc-300">·</span>
                                    <span>{s.chapter_title}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* 底部输入框 */}
            <div className="px-6 py-4 border-t border-zinc-100 bg-white flex-shrink-0">
                <div className="max-w-3xl mx-auto flex gap-2 items-end">
                    {/* 模式切换：三段式选择 */}
                    {currentBook && (
                        <div className="flex bg-zinc-100 rounded-full p-0.5 gap-0.5 flex-shrink-0">
                            {[
                                { id: 'chapter', icon: '📖', label: '当前章', title: '仅基于当前章节回答' },
                                { id: 'book', icon: '🌐', label: '整本书', title: '基于当前整本书回答' },
                                { id: 'cross', icon: '📚', label: '综合阅读', title: '基于多本书对比回答' },
                            ].map(mode => (
                                <button
                                    key={mode.id}
                                    onClick={() => onToggleMode(mode.id)}
                                    disabled={isStreaming}
                                    title={mode.title}
                                    className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap
                                        ${chatMode === mode.id
                                            ? 'bg-white text-zinc-800 shadow-sm'
                                            : 'text-zinc-500 hover:text-zinc-700'}`}
                                >
                                    {mode.icon} {mode.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="flex-1 relative">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={!(currentBook || chatMode === 'cross') ? '请先选择一本书' : (chatMode === 'cross' && selectedBookIds?.length === 0 ? '请先在左侧勾选要搜索的书籍...' : '输入你的问题...')}
                            disabled={!(currentBook || chatMode === 'cross') || isStreaming}
                            className="w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-full text-sm
                                focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent
                                disabled:opacity-50 disabled:cursor-not-allowed
                                placeholder:text-zinc-400 transition-all"
                        />
                        {chatMode === 'cross' && selectedBookIds?.length === 0 && currentBook && (
                            <div className="absolute -bottom-5 left-0 right-0">
                                <p className="text-[11px] text-zinc-400 flex items-center gap-1">
                                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                    </svg>
                                    请先在左侧勾选要搜索的书籍
                                </p>
                            </div>
                        )}
                    </div>
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isStreaming || (!currentBook && chatMode !== 'cross') || (chatMode === 'cross' && selectedBookIds?.length === 0)}
                        className="w-10 h-10 flex items-center justify-center bg-zinc-800 text-white rounded-full
                            hover:bg-zinc-900 active:scale-95
                            disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
                            transition-all flex-shrink-0"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}
