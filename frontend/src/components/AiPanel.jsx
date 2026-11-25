import { useState, useRef, useEffect } from 'react';
import ToolMessageCard from './ToolMessageCard.jsx';
import ToolMenu from './ToolMenu.jsx';

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

// 「《书名》·章节名」徽章（旧机制保留）
function renderBadges(text, keyBase) {
    const parts = text.split(/(「[^」]+」)/g);
    if (parts.length === 1) return text;
    return parts.map((part, i) => {
        const match = part.match(/「([^」]+)」/);
        if (match) {
            const [bookPart, chapterPart] = match[1].split('·');
            return (
                <span key={`${keyBase}-${i}`} className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 bg-zinc-50 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-300 rounded text-xs font-medium border border-zinc-200 dark:border-zinc-800">
                    {bookPart}
                    {chapterPart && <span className="text-zinc-300">·</span>}
                    {chapterPart || null}
                </span>
            );
        }
        return part;
    });
}

// 句内引用：把与本轮 sources.index 对应的 [n] 渲染为可点击上标角标（点→跳原文段落高亮）；
// 无对应来源（历史存量/模型编号越界）时按普通文本保留
function renderInlineCitations(text, sources, onCite, keyBase) {
    const byIndex = new Map((sources || []).filter(s => s && s.index).map(s => [s.index, s]));
    if (byIndex.size === 0) return renderBadges(text, keyBase);
    const segs = text.split(/(\[\d{1,2}\])/g);
    return segs.map((seg, i) => {
        const m = seg.match(/^\[(\d{1,2})\]$/);
        if (m && byIndex.has(+m[1])) {
            const n = +m[1];
            const src = byIndex.get(n);
            return (
                <button
                    key={`${keyBase}-${i}`}
                    data-cite={n}
                    className="cite-marker"
                    title={src.chapter_title}
                    onClick={() => onCite?.(src)}
                >
                    {n}
                </button>
            );
        }
        return renderBadges(seg, `${keyBase}-${i}`);
    });
}

function renderMessageParagraphs(text, sources, onCite) {
    const cleaned = cleanMarkdown(text);
    const paragraphs = cleaned.split(/\n\n+/).filter(p => p.trim());
    if (paragraphs.length <= 1) {
        return <p className="text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed" style={{ textIndent: '2em' }}>{renderInlineCitations(cleaned, sources, onCite, 'p')}</p>;
    }
    return paragraphs.map((para, i) => (
        <p key={i} className="text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed mt-1.5" style={{ textIndent: '2em' }}>{renderInlineCitations(para, sources, onCite, `p${i}`)}</p>
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
    quoteDraft, onClearQuote,
    // v3.1 三区宽度可拖拽自定义（BookReader 持有并持久化）
    width = 400,
    // v3.1 工具入口并入 ➕ 级联（原顶栏工具抽屉移除）
    onRunTool, busyToolId, toolScopeAll, onToolScopeChange, scopeLabel, hasChapter,
}) {
    const [input, setInput] = useState('');
    const [plusOpen, setPlusOpen] = useState(false);
    const [plusGroup, setPlusGroup] = useState(null);
    const chatEndRef = useRef(null);

    // 引用跳源：带上段落锚点 snippet（存量旧消息无此字段=只跳章首）
    const citeJump = (src) => src && onNavigateToSource?.(src.book_id, src.chapter_id, src.snippet);

    // v3.1：工具与专家模式并列为 ➕ 级联一级项
    const MENU_GROUPS = [
        { id: 'experts', label: '专家模式', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
        { id: 'tools', label: '工具', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z' },
    ];
    const expertStarters = (activeExpert?.quickPrompts || []).filter(q => !q.startsWith('收束'));
    const hasUserMsg = messages.some(m => m.role === 'user');

    useEffect(() => {
        if (open) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, open]);

    const handleSend = () => {
        if (isStreaming) return;
        const text = input.trim();
        // v2.7：只带引用不带问题也允许发送（后端有兜底提问）
        if (!text && !quoteDraft?.text) return;
        onSendMessage(text, quoteDraft?.text ? quoteDraft : undefined);
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
            <div className="w-9 flex-shrink-0 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col items-center py-2 gap-1">
                <button onClick={onToggle} className="p-1.5 rounded-lg text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-all" title="展开 AI 区">
                    <BubbleIcon />
                </button>
                {(isStreaming || messages.length > 0) && (
                    <span className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-zinc-500 animate-pulse' : 'bg-zinc-200 dark:bg-zinc-700'}`}></span>
                )}
            </div>
        );
    }

    return (
        // overflow-hidden 必须去掉：➕ 级联面板要能越出本栏左缘（旧版被裁剪=「内容跑到屏幕外」的根因）
        <div data-pane="ai" className="flex-shrink-0 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col" style={{ width }}>
            {/* 头部 */}
            <div className="px-4 pt-3.5 pb-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between flex-shrink-0">
                <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">AI 助手</span>
                <button onClick={onToggle} className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-all" title="收起">
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
                                return <ToolMessageCard key={i} msg={msg} bookId={currentBook?.book_id} favorites={favorites} onToggleFavorite={onToggleFavorite} onNavigateToSource={onNavigateToSource} />;
                            }
                            if (msg.kind === 'report') {
                                const rtTitle = `收束报告${activeExpert ? ` · ${activeExpert.name}` : ''}`;
                                const rtFav = favorites?.some(f => f.type === 'report' && (f.answer || '') === (msg.content || ''));
                                return (
                                    <div key={i} className="message-enter">
                                        <div className="rounded-2xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-900/70 px-5 py-4">
                                            <div className="flex items-center gap-1.5 mb-2">
                                                <svg className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                </svg>
                                                <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{rtTitle}</span>
                                                <button
                                                    onClick={() => onToggleFavorite({ type: 'report', question: rtTitle, answer: msg.content || '' })}
                                                    className={`ml-auto p-1 rounded-lg transition-all flex-shrink-0 ${rtFav ? 'text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800' : 'text-zinc-300 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                                                    title={rtFav ? '移出资产区' : '归档报告'}
                                                >
                                                    <svg className="w-3.5 h-3.5" fill={rtFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                                                    </svg>
                                                </button>
                                            </div>
                                            {renderMessageParagraphs(msg.content, msg.sources, citeJump)}
                                        </div>
                                    </div>
                                );
                            }
                            return (
                                <div key={i} className={`message-enter flex gap-2 items-start ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[85%] min-w-0 px-4 py-2.5 ${msg.role === 'user' ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 rounded-2xl rounded-br-md' : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 rounded-2xl rounded-bl-md border border-zinc-100 dark:border-zinc-800'}`}>
                                        {msg.role === 'user' ? (
                                            <>
                                                {msg.quote?.text && (
                                                    <div data-msg-quote className="mb-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border-l-2 border-amber-300 dark:border-amber-500/40 text-[12px] text-amber-800 dark:text-amber-300 leading-relaxed max-h-28 overflow-hidden">
                                                        <span>「{msg.quote.text.length > 160 ? msg.quote.text.slice(0, 160) + '…' : msg.quote.text}」</span>
                                                        {msg.quote.chapter_title && (
                                                            <div className="mt-0.5 text-[10px] text-amber-500">—— {msg.quote.chapter_title}</div>
                                                        )}
                                                    </div>
                                                )}
                                                <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                            </>
                                        ) : (
                                            renderMessageParagraphs(msg.content, msg.sources, citeJump)
                                        )}
                                        {/* 逐条来源（含刷新恢复的存量消息） */}
                                        {msg.role === 'assistant' && msg.sources?.length > 0 && (
                                            <div className="mt-2 pt-2 border-t border-zinc-50 dark:border-zinc-800 flex flex-wrap gap-1.5">
                                                {msg.sources.map((s, j) => (
                                                    <button key={j} data-source-chip={s.index || j + 1} onClick={() => citeJump(s)} className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-50 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400 rounded-full text-[11px] border border-zinc-100 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                                                        <span className="min-w-[14px] h-[14px] px-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-400 dark:text-zinc-500 text-[9px] leading-[13px] text-center tabular-nums">{s.index || j + 1}</span>
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
                                                    className={`p-1.5 rounded-lg transition-all flex-shrink-0 mt-1 ${alreadyFav ? 'text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-950' : 'text-zinc-300 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}
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
            <div className="px-4 pt-2 pb-3.5 border-t border-zinc-100 dark:border-zinc-800 flex-shrink-0">
                {activeExpert && (
                    <div className="mb-2">
                        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 min-w-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 flex-shrink-0"></span>
                            <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 flex-shrink-0">{activeExpert.name}</span>
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{activeExpert.method}</span>
                            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                                <button
                                    onClick={onGenerateReport}
                                    disabled={isStreaming || !currentSessionId || !hasUserMsg}
                                    className="px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-800 dark:bg-zinc-700 text-white hover:bg-zinc-900 dark:hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                >
                                    收束报告
                                </button>
                                <button
                                    onClick={onNewSession}
                                    disabled={isStreaming}
                                    className="px-2.5 py-1 rounded-full text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-all"
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
                                        className="text-[11px] px-2.5 py-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-600 transition-all"
                                    >
                                        {q}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {/* v2.7 划线引用 chip：随下一条提问一起送出 */}
                {quoteDraft?.text && (
                    <div data-quote-chip className="mb-2 flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 min-w-0">
                        <svg className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                        <div className="min-w-0 flex-1">
                            <p className="text-[12px] text-amber-800 dark:text-amber-300 leading-snug max-h-10 overflow-hidden">「{quoteDraft.text.length > 90 ? quoteDraft.text.slice(0, 90) + '…' : quoteDraft.text}」</p>
                            {quoteDraft.chapter_title && (
                                <p className="text-[10px] text-amber-500 mt-0.5 truncate">—— {quoteDraft.chapter_title}</p>
                            )}
                        </div>
                        <button onClick={onClearQuote} data-quote-clear title="移除引用"
                                className="p-0.5 rounded text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors flex-shrink-0">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                )}
                <div className="flex gap-2 items-end">
                    {/* + 二级级联菜单（v3.1：专家模式 + 工具；向左展开，避免越出屏幕右缘） */}
                    <div className="relative flex-shrink-0">
                        <button
                            data-testid="plus-menu"
                            onClick={() => { setPlusOpen(o => !o); setPlusGroup(null); }}
                            disabled={isStreaming}
                            className={`w-10 h-10 flex items-center justify-center rounded-full border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${plusOpen ? 'bg-zinc-800 dark:bg-zinc-700 text-white border-zinc-800' : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 hover:text-zinc-800 dark:hover:text-zinc-100'}`}
                        >
                            <svg className={`w-5 h-5 transition-transform ${plusOpen ? 'rotate-45' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                        </button>
                        {plusOpen && (
                            <>
                                <div className="fixed inset-0 z-30" onClick={() => { setPlusOpen(false); setPlusGroup(null); }} />
                                {/* 右缘锚定 + 子面板排在一级菜单左侧：整体向左上展开，不再越出屏幕 */}
                                <div className="absolute bottom-full right-0 mb-2 z-40 flex items-end gap-1.5">
                                    {plusGroup === 'experts' && (
                                        <div className="w-80 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg p-1.5 max-h-96 overflow-y-auto scrollbar-thin">
                                            {experts.length === 0 ? (
                                                <div className="px-4 py-3 text-xs text-zinc-400 dark:text-zinc-500 text-center">暂无可用专家</div>
                                            ) : experts.map(e => (
                                                <button
                                                    key={e.expert_id}
                                                    onClick={() => { setPlusOpen(false); setPlusGroup(null); onOpenExpert?.(e.expert_id); }}
                                                    disabled={!currentBook || expertOpening}
                                                    className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                                                >
                                                    <div className="flex items-baseline gap-2 min-w-0">
                                                        <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex-shrink-0">{e.name}</span>
                                                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{e.profession}</span>
                                                    </div>
                                                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">{e.displayDescription}</p>
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {(e.tags || []).map(t => (
                                                            <span key={t} className="text-[10px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 rounded">{t}</span>
                                                        ))}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {plusGroup === 'tools' && (
                                        <ToolMenu
                                            disabled={isStreaming || !currentBook}
                                            busyToolId={busyToolId}
                                            onRunTool={onRunTool}
                                            scopeLabel={scopeLabel}
                                            scopeAll={toolScopeAll}
                                            onScopeChange={onToolScopeChange}
                                            hasChapter={hasChapter}
                                            onActioned={() => { setPlusOpen(false); setPlusGroup(null); }}
                                        />
                                    )}
                                    <div className="w-40 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg py-1">
                                        {MENU_GROUPS.map(g => (
                                            <button
                                                key={g.id}
                                                onMouseEnter={() => setPlusGroup(g.id)}
                                                onClick={() => setPlusGroup(g.id)}
                                                className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${plusGroup === g.id ? 'bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <svg className="w-4 h-4 text-zinc-400 dark:text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={g.icon} />
                                                    </svg>
                                                    {g.label}
                                                </span>
                                                <svg className="w-3.5 h-3.5 text-zinc-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                                </svg>
                                            </button>
                                        ))}
                                    </div>
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
                            className="w-full px-4 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-zinc-400 transition-all"
                        />
                    </div>
                    <button
                        onClick={handleSend}
                        disabled={(!input.trim() && !quoteDraft?.text) || isStreaming || !currentBook}
                        className="w-10 h-10 flex items-center justify-center bg-zinc-800 dark:bg-zinc-700 text-white rounded-full hover:bg-zinc-900 dark:hover:bg-zinc-600 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 transition-all flex-shrink-0"
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
