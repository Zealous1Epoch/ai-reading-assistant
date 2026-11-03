import { useState, useRef, useEffect } from 'react';
import ToolMessageCard from './ToolMessageCard.jsx';

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

const BubbleIcon = ({ className }) => (
    <svg className={className || 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
);

// AI 专区：对话流（问答 + 专家 + 工具产出统一时间线）；收起为 36px 图标细栏
function AiPanel({
    open, onToggle, currentBook, messages, isStreaming, onSendMessage,
    favorites, onToggleFavorite, onNavigateToSource,
    experts = [], activeExpert, expertOpening = false, onOpenExpert, onGenerateReport,
    currentSessionId, onNewSession,
}) {
    const [input, setInput] = useState('');
    const [plusOpen, setPlusOpen] = useState(false);
    const [plusGroup, setPlusGroup] = useState(null);
    const chatEndRef = useRef(null);

    const MENU_GROUPS = [{ id: 'experts', label: '专家模式' }];
    const expertStarters = (activeExpert?.quickPrompts || []).filter(q => !q.startsWith('收束'));
    const hasUserMsg = messages.some(m => m.role === 'user');

    useEffect(() => {
        if (open) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, open]);

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

    if (!open) {
        return (
            <div className="w-9 flex-shrink-0 bg-white rounded-2xl border border-zinc-200 flex flex-col items-center py-2 gap-1">
                <button onClick={onToggle} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50 transition-all" title="展开 AI 区">
                    <BubbleIcon />
                </button>
                {(isStreaming || messages.length > 0) && (
                    <span className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-zinc-500 animate-pulse' : 'bg-zinc-200'}`}></span>
                )}
            </div>
        );
    }

    return (
        <div className="flex-shrink-0 bg-white rounded-2xl border border-zinc-200 flex flex-col overflow-hidden" style={{ width: '400px' }}>
            {/* 头部 */}
            <div className="px-4 pt-3.5 pb-2.5 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">AI 助手</span>
                <button onClick={onToggle} className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-700 hover:bg-zinc-50 transition-all" title="收起">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                    </svg>
                </button>
            </div>

            {/* 消息流：问答 / 专家开场与报告 / 工具产出，统一时间线 */}
            <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
                {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="text-center">
                            <BubbleIcon className="w-8 h-8 mx-auto text-zinc-200 mb-2" />
                            <p className="text-xs text-zinc-300">暂无对话</p>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {messages.map((msg, i) => {
                            if (msg.kind === 'tool') {
                                return <ToolMessageCard key={i} msg={msg} favorites={favorites} onToggleFavorite={onToggleFavorite} onNavigateToSource={onNavigateToSource} />;
                            }
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
                                    <div className={`max-w-[85%] min-w-0 px-4 py-2.5 ${msg.role === 'user' ? 'bg-zinc-100 text-zinc-700 rounded-2xl rounded-br-md' : 'bg-white text-zinc-700 rounded-2xl rounded-bl-md border border-zinc-100'}`}>
                                        {msg.role === 'user' ? (
                                            <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                        ) : (
                                            renderMessageParagraphs(msg.content)
                                        )}
                                        {/* 逐条来源（含刷新恢复的存量消息） */}
                                        {msg.role === 'assistant' && msg.sources?.length > 0 && (
                                            <div className="mt-2 pt-2 border-t border-zinc-50 flex flex-wrap gap-1.5">
                                                {msg.sources.map((s, j) => (
                                                    <button key={j} onClick={() => onNavigateToSource?.(s.book_id, s.chapter_id)} className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-50 text-zinc-500 rounded-full text-[11px] border border-zinc-100 hover:bg-zinc-100 transition-colors">
                                                        <span className="font-semibold">{s.book_title || currentBook?.title}</span>
                                                        <span className="text-zinc-300">·</span>
                                                        <span>{s.chapter_title}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    {msg.role === 'assistant' && !msg.kind && !msg.streaming && messages[i - 1]?.role === 'user' && msg.content?.trim() && (
                                        (() => {
                                            const alreadyFav = favorites?.some(f => f.question === messages[i - 1].content && f.answer === msg.content);
                                            return (
                                                <button
                                                    onClick={() => onToggleFavorite({ type: 'qa', question: messages[i - 1].content, answer: msg.content })}
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
                        <div ref={chatEndRef} />
                    </div>
                )}
            </div>

            {/* 底部：专家状态条 + 输入 */}
            <div className="px-4 pt-2 pb-3.5 border-t border-zinc-100 flex-shrink-0">
                {activeExpert && (
                    <div className="mb-2">
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
                <div className="flex gap-2 items-end">
                    {/* + 二级级联菜单（专家模式入口） */}
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
                    <div className="flex-1 relative min-w-0">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={expertOpening ? '专家进场中…' : '输入你的问题...'}
                            disabled={!currentBook || isStreaming || expertOpening}
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

export default AiPanel;
