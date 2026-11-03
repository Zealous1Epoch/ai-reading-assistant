import { useState, useRef, useEffect } from 'react';

const API_BASE = '';

// HTML 实体转义（防止 XSS）
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return text.replace(/[&<>"']/g, c => map[c]);
}

// 清理 AI 回复中的 Markdown 符号并转义 HTML
function cleanMarkdown(text) {
    return escapeHtml(text)
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

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return hm;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function MiddlePanel({ currentBook, currentChapter, chatMessages, isStreaming, onSendMessage, viewMode = 'reading', onToggleView, sources, onToggleFavorite, onNavigateToSource, favorites, sessions = [], currentSessionId, onNewSession, onSelectSession, onDeleteSession, experts = [], activeExpert, expertOpening = false, onOpenExpert, onGenerateReport }) {
    const [input, setInput] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [plusOpen, setPlusOpen] = useState(false);
    const [plusGroup, setPlusGroup] = useState(null);
    const [chapterSummary, setChapterSummary] = useState(null);
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [expandedChapter, setExpandedChapter] = useState(false);
    const chatEndRef = useRef(null);

    // "+" 一级菜单分组（后续功能在此追加分组，二级面板按 group 渲染）
    const MENU_GROUPS = [
        { id: 'experts', label: '专家模式' },
    ];
    // 专家建议条只放对话开场；"收束：…"类指令由收束报告按钮承担
    const expertStarters = (activeExpert?.quickPrompts || []).filter(q => !q.startsWith('收束'));
    const hasUserMsg = chatMessages.some(m => m.role === 'user');
    const expertNameOf = (id) => experts.find(e => e.expert_id === id)?.name;

    function renderWithCitations(text) {
        const parts = text.split(/(「[^」]+」)/g);
        if (parts.length === 1) return text;
        return parts.map((part, i) => {
            const match = part.match(/「([^」]+)」/);
            if (match) {
                const [bookPart, chapterPart] = match[1].split('·');
                return (
                    <span key={i} className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 bg-zinc-50 text-zinc-600 rounded text-xs font-medium border border-zinc-200">
                        {bookPart}
                        {chapterPart && <span className="text-zinc-300">·</span>}
                        {chapterPart || null}
                    </span>
                );
            }
            return part;
        });
    }

    function cleanChapterContent(text) {
        return text
            .replace(/\[PAGE\s*\d+\]/gi, '')
            .split('\n')
            .filter(line => {
                const s = line.trim();
                if (!s) return true;
                if (/^[\d\s\.\,\-\+\=\(\)\[\]\{\}\/\\\|\&\*\%\$\#\@\!]+$/.test(s)) return false;
                const garbage = s.replace(/[a-zA-Z0-9一-鿿　-〿＀-￯\s.,;:!?()《》、，。；：？！—…·\t\-]/g, '');
                return garbage.length / s.length < 0.4;
            })
            .join('\n')
            .replace(/\n{4,}/g, '\n\n\n')
            .replace(/ {3,}/g, '  ')
            .trim();
    }

    function renderChapterParagraphs(text) {
        const cleaned = cleanChapterContent(text);
        const blocks = cleaned.split(/\n\n+/).filter(p => p.trim());
        return blocks.map((block, i) => {
            const lines = block.split('\n').filter(l => l.trim());
            if (lines.length === 0) return null;

            const firstLine = lines[0];
            const isHeading = /^(\d+[\.\、\)]\s*|第[一二三四五六七八九十\d]+[章节])\s*/.test(firstLine)
                           || (firstLine.length <= 25 && !/[。，；]$/.test(firstLine));

            if (isHeading) {
                const bodyLines = lines.slice(1).filter(l => l.trim());
                return (
                    <div key={i}>
                        <p className="text-base font-bold text-zinc-900 mt-5 mb-1">{firstLine}</p>
                        {bodyLines.length > 0 && (
                            <div className="border-l-2 border-zinc-200 pl-4 py-1 bg-zinc-50/50 rounded-r-lg">
                                {bodyLines.map((l, j) => (
                                    <p key={j} className="text-sm text-zinc-700 leading-relaxed" style={{ textIndent: '2em' }}>{l.trim()}</p>
                                ))}
                            </div>
                        )}
                    </div>
                );
            }

            return (
                <div key={i} className="border-l-2 border-zinc-200 pl-4 py-2 my-2 bg-zinc-50/50 rounded-r-lg">
                    <p className="text-sm text-zinc-700 leading-relaxed" style={{ textIndent: '2em' }}>{block.trim()}</p>
                </div>
            );
        });
    }

    function renderMessageParagraphs(text) {
        const cleaned = cleanMarkdown(text);
        const paragraphs = cleaned.split(/\n\n+/).filter(p => p.trim());
        if (paragraphs.length <= 1) {
            return <p className="text-sm text-zinc-700 leading-relaxed" style={{ textIndent: '2em' }}>{renderWithCitations(cleaned)}</p>;
        }
        return paragraphs.map((para, i) => (
            <p key={i} className="text-sm text-zinc-700 leading-relaxed mt-1.5" style={{ textIndent: '2em' }}>{renderWithCitations(para)}</p>
        ));
    }

    useEffect(() => {
        if (currentChapter?.chapter_id) {
            setSummaryLoading(true);
            setExpandedChapter(false);
            setChapterSummary(null);
            fetch(`${API_BASE}/analysis/chapter/${currentChapter.chapter_id}/summary`)
                .then(res => res.json())
                .then(data => {
                    if (data.summary) setChapterSummary(data);
                    setSummaryLoading(false);
                })
                .catch(() => setSummaryLoading(false));
        }
    }, [currentChapter?.chapter_id]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages, viewMode]);

    const handleSend = () => {
        if (!input.trim() || isStreaming) return;
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
                <h1 className="text-base font-serif-heading font-semibold text-zinc-800 truncate">
                    {currentBook ? (
                        <span className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-800 flex-shrink-0"></span>
                            {currentBook.title}
                        </span>
                    ) : '智能读书助手'}
                </h1>
                {currentChapter && (
                    <div className="ml-auto text-xs text-zinc-400">{currentChapter.title}</div>
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
                ) : viewMode === 'reading' ? (
                    <div className="animate-fade-in max-w-3xl">
                        {currentChapter ? (
                            <div className="border border-zinc-200 rounded-3xl bg-white">
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
                                    <h2 className="text-lg font-serif-heading font-semibold text-zinc-900">{currentChapter.title}</h2>
                                </div>
                                <div className="px-6 py-4">
                                    {summaryLoading ? (
                                        <div className="flex items-center gap-2 text-zinc-400 text-sm py-3">
                                            <div className="animate-spin h-4 w-4 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                                            正在生成摘要...
                                        </div>
                                    ) : chapterSummary?.summary ? (
                                        <>
                                            <div className="bg-zinc-50 rounded-xl p-4 mb-3">
                                                <p className="text-sm text-zinc-600 leading-relaxed">{chapterSummary.summary}</p>
                                            </div>
                                            {chapterSummary.keywords?.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {chapterSummary.keywords.map((kw, i) => (
                                                        <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-white text-zinc-500 border border-zinc-200">{kw}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </>
                                    ) : null}
                                </div>
                                <div className="px-6 pb-5">
                                    {currentChapter.content ? (
                                        <>
                                            <button onClick={() => setExpandedChapter(!expandedChapter)} className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 transition-colors">
                                                {expandedChapter ? '收起全文' : '展开全文'}
                                                <svg className={`w-3.5 h-3.5 transition-transform ${expandedChapter ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                                </svg>
                                            </button>
                                            {expandedChapter && (
                                                <div className="mt-4 pt-4 border-t border-zinc-100 space-y-1">
                                                    {renderChapterParagraphs(currentChapter.content)}
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
                        {currentBook?.summary && (
                            <div className="mt-6 bg-zinc-50 rounded-xl p-5">
                                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">书籍摘要</h3>
                                <p className="text-sm text-zinc-600 leading-relaxed">{currentBook.summary}</p>
                            </div>
                        )}
                    </div>
                ) : null}

                {/* 对话视图：消息流 */}
                {viewMode === 'chat' && chatMessages.length === 0 && (
                    <div className="text-center text-zinc-300 text-sm py-16">暂无对话</div>
                )}
                {viewMode === 'chat' && chatMessages.length > 0 && (
                    <div className="max-w-3xl space-y-4">
                        {chatMessages.map((msg, i) => {
                            if (msg.kind === 'report') {
                                return (
                                    <div key={i} className="message-enter">
                                        <div className="rounded-2xl border border-zinc-300 bg-zinc-50/80 px-5 py-4">
                                            <div className="flex items-center gap-1.5 mb-2">
                                                <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                </svg>
                                                <span className="text-xs font-semibold text-zinc-600">收束报告{activeExpert ? ` · ${activeExpert.name}` : ''}</span>
                                            </div>
                                            {renderMessageParagraphs(msg.content)}
                                        </div>
                                    </div>
                                );
                            }
                            return (
                                <div key={i} className={`message-enter flex gap-2 items-start ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] px-4 py-2.5 ${msg.role === 'user' ? 'bg-zinc-100 text-zinc-700 rounded-2xl rounded-br-md' : 'bg-white text-zinc-700 rounded-2xl rounded-bl-md border border-zinc-100'}`}>
                                        {msg.role === 'user' ? (
                                            <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                        ) : (
                                            renderMessageParagraphs(msg.content)
                                        )}
                                    </div>
                                    {msg.role === 'assistant' && !msg.kind && chatMessages[i - 1]?.role === 'user' && (
                                        (() => {
                                            const alreadyFav = favorites?.some(f => f.question === chatMessages[i - 1].content && f.answer === msg.content);
                                            return (
                                                <button
                                                    onClick={() => onToggleFavorite({ type: 'qa', question: chatMessages[i - 1].content, answer: msg.content })}
                                                    className={`p-1.5 rounded-lg transition-all flex-shrink-0 mt-1 ${alreadyFav ? 'text-zinc-500 bg-zinc-50' : 'text-zinc-300 hover:text-zinc-500 hover:bg-zinc-50'}`}
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
                            );
                        })}
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
                {viewMode === 'chat' && sources?.length > 0 && chatMessages.length > 0 && (
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
                {/* 会话操作行 */}
                <div className="max-w-3xl mx-auto flex justify-end gap-1.5 pb-2 relative">
                    <button
                        onClick={onNewSession}
                        disabled={isStreaming}
                        className="px-2.5 py-1 rounded-full text-xs text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition-all"
                    >
                        ＋ 新对话
                    </button>
                    <div className="relative">
                        <button
                            onClick={() => setHistoryOpen(o => !o)}
                            className={`px-2.5 py-1 rounded-full text-xs transition-all ${historyOpen ? 'bg-zinc-100 text-zinc-800' : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100'}`}
                        >
                            历史 {sessions.length > 0 ? `(${sessions.length})` : ''}
                        </button>
                        {historyOpen && (
                            <div className="absolute right-0 bottom-full mb-2 w-72 max-h-72 overflow-y-auto scrollbar-thin bg-white border border-zinc-200 rounded-xl shadow-lg py-1 z-30">
                                {sessions.length === 0 ? (
                                    <div className="px-4 py-3 text-xs text-zinc-400 text-center">暂无历史会话</div>
                                ) : sessions.map(s => (
                                    <div
                                        key={s.session_id}
                                        className={`group flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors ${s.session_id === currentSessionId ? 'bg-zinc-50 text-zinc-800' : 'text-zinc-500 hover:bg-zinc-50'}`}
                                        onClick={() => { onSelectSession(s.session_id); setHistoryOpen(false); }}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="truncate text-[13px]">{s.title}</div>
                                            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                                                <span>{fmtTime(s.updated_at)} · {s.message_count} 条</span>
                                                {s.expert_id && expertNameOf(s.expert_id) && (
                                                    <span className="px-1.5 py-px rounded bg-zinc-100 text-zinc-500 border border-zinc-200 flex-shrink-0">{expertNameOf(s.expert_id)}</span>
                                                )}
                                            </div>
                                        </div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onDeleteSession(s.session_id); }}
                                            className="opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-red-400 transition-all text-xs px-1"
                                            title="删除"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                {/* 专家模式状态条 */}
                {activeExpert && (
                    <div className="max-w-3xl mx-auto mb-2">
                        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-50 border border-zinc-200 min-w-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 flex-shrink-0"></span>
                            <span className="text-xs font-semibold text-zinc-800 flex-shrink-0">{activeExpert.name}</span>
                            <span className="text-[11px] text-zinc-400 truncate">{activeExpert.method}</span>
                            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                                <button
                                    onClick={onGenerateReport}
                                    disabled={isStreaming || !currentSessionId || !hasUserMsg}
                                    className="px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-800 text-white hover:bg-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                >
                                    收束报告
                                </button>
                                <button
                                    onClick={onNewSession}
                                    disabled={isStreaming}
                                    className="px-2.5 py-1 rounded-full text-xs text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 disabled:opacity-40 transition-all"
                                >
                                    退出
                                </button>
                            </div>
                        </div>
                        {expertStarters.length > 0 && !isStreaming && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {expertStarters.map((q, i) => (
                                    <button
                                        key={i}
                                        onClick={() => onSendMessage(q)}
                                        className="text-[11px] px-2.5 py-1 rounded-full bg-white border border-zinc-200 text-zinc-500 hover:text-zinc-800 hover:border-zinc-400 transition-all"
                                    >
                                        {q}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <div className="max-w-3xl mx-auto flex gap-2 items-end">
                    {/* ＋ 二级级联菜单 */}
                    <div className="relative flex-shrink-0">
                        <button
                            onClick={() => { setPlusOpen(o => !o); setPlusGroup(null); }}
                            disabled={isStreaming}
                            className={`w-10 h-10 flex items-center justify-center rounded-full border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${plusOpen ? 'bg-zinc-800 text-white border-zinc-800' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400 hover:text-zinc-800'}`}
                        >
                            <svg className={`w-5 h-5 transition-transform ${plusOpen ? 'rotate-45' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                        </button>
                        {plusOpen && (
                            <>
                                <div className="fixed inset-0 z-30" onClick={() => { setPlusOpen(false); setPlusGroup(null); }} />
                                <div className="absolute bottom-full left-0 mb-2 z-40 flex items-end gap-1.5">
                                    <div className="w-40 bg-white border border-zinc-200 rounded-xl shadow-lg py-1">
                                        {MENU_GROUPS.map(g => (
                                            <button
                                                key={g.id}
                                                onMouseEnter={() => setPlusGroup(g.id)}
                                                onClick={() => setPlusGroup(g.id)}
                                                className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${plusGroup === g.id ? 'bg-zinc-50 text-zinc-800' : 'text-zinc-600 hover:bg-zinc-50'}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <svg className="w-4 h-4 text-zinc-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                                    </svg>
                                                    {g.label}
                                                </span>
                                                <svg className="w-3.5 h-3.5 text-zinc-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                            </button>
                                        ))}
                                    </div>
                                    {plusGroup === 'experts' && (
                                        <div className="w-80 bg-white border border-zinc-200 rounded-xl shadow-lg p-1.5 max-h-96 overflow-y-auto scrollbar-thin">
                                            {experts.length === 0 ? (
                                                <div className="px-4 py-3 text-xs text-zinc-400 text-center">暂无可用专家</div>
                                            ) : experts.map(e => (
                                                <button
                                                    key={e.expert_id}
                                                    onClick={() => { setPlusOpen(false); setPlusGroup(null); onOpenExpert?.(e.expert_id); }}
                                                    disabled={!currentBook || expertOpening}
                                                    className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-zinc-50 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                                                >
                                                    <div className="flex items-baseline gap-2 min-w-0">
                                                        <span className="text-sm font-semibold text-zinc-800 flex-shrink-0">{e.name}</span>
                                                        <span className="text-[11px] text-zinc-400 truncate">{e.profession}</span>
                                                    </div>
                                                    <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{e.displayDescription}</p>
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {(e.tags || []).map(t => (
                                                            <span key={t} className="text-[10px] px-1.5 py-0.5 bg-zinc-100 text-zinc-500 rounded">{t}</span>
                                                        ))}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                    <div className="flex bg-zinc-100 rounded-full p-0.5 gap-0.5 flex-shrink-0">
                        {[
                            { id: 'reading', icon: '\u{1F4D6}', label: '阅读' },
                            { id: 'chat', icon: '\u{1F4AC}', label: '对话' },
                        ].map(vm => (
                            <button
                                key={vm.id}
                                onClick={() => onToggleView?.(vm.id)}
                                className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap ${viewMode === vm.id ? 'bg-white text-zinc-800 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                            >
                                {vm.icon} {vm.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex-1 relative">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={!currentBook ? '请先选择一本书' : '输入你的问题...'}
                            disabled={!currentBook || isStreaming}
                            className="w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-zinc-400 transition-all"
                        />
                    </div>
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isStreaming || !currentBook}
                        className="w-10 h-10 flex items-center justify-center bg-zinc-800 text-white rounded-full hover:bg-zinc-900 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 transition-all flex-shrink-0"
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

export default MiddlePanel;
