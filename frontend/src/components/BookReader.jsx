import { useState, useEffect, useRef } from 'react';
import SessionRail from './SessionRail.jsx';
import ReadingPane from './ReadingPane.jsx';
import AiPanel from './AiPanel.jsx';
import ToolDrawer from './ToolDrawer.jsx';
import FavoritesDrawer from './FavoritesDrawer.jsx';

const API_BASE = '';

function ToggleButton({ active, onClick, label, badge, children }) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${active ? 'bg-zinc-100 text-zinc-700' : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50'}`}
            title={label}
        >
            {children}
            <span>{label}</span>
            {badge > 0 && (
                <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-zinc-200 text-zinc-500 text-[9px] leading-[15px] text-center tabular-nums">
                    {badge > 99 ? '99+' : badge}
                </span>
            )}
        </button>
    );
}

// 目录抽屉：顶栏唤出，挂章节树（toc 优先，匹配率低降级平铺）+ 本书全文搜索
function TocDrawer({ book, currentChapter, onSelectChapter, onClose }) {
    const [keyword, setKeyword] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);
    const timerRef = useRef(null);

    const runSearch = (val) => {
        clearTimeout(timerRef.current);
        if (val.trim().length < 2) { setResults(null); return; }
        setSearching(true);
        timerRef.current = setTimeout(async () => {
            try {
                const res = await fetch(`${API_BASE}/search/fulltext?keyword=${encodeURIComponent(val.trim())}&book_id=${book.book_id}&limit=20`);
                const data = await res.json();
                setResults(data.matches || []);
            } catch { setResults([]); }
            finally { setSearching(false); }
        }, 300);
    };

    const chapters = book.chapters || [];
    const toc = book.toc || [];
    const tocMatchRate = toc.length > 0
        ? toc.filter(item => chapters.some(c => c.title === item.title)).length / toc.length
        : 0;

    const renderToc = () => {
        if (results !== null) {
            // 搜索结果视图（按章聚合的命中）
            return results.length === 0 ? (
                <p className="text-xs text-zinc-300 text-center py-6">未找到</p>
            ) : results.map((m, i) => (
                <div
                    key={i}
                    onClick={() => {
                        const ch = chapters.find(c => c.chapter_id === m.chapter_id);
                        if (ch) { onSelectChapter(ch); onClose(); }
                    }}
                    className="px-3 py-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors"
                >
                    <p className="text-xs font-medium text-zinc-700 truncate">{m.chapter_title}</p>
                    <p className="text-[11px] text-zinc-400 leading-relaxed line-clamp-2 mt-0.5">{m.snippet}</p>
                </div>
            ));
        }
        if (chapters.length === 0) {
            return <p className="text-xs text-zinc-300 text-center py-6">暂无章节</p>;
        }
        if (toc.length === 0 || tocMatchRate < 0.8) {
            return chapters.map(ch => {
                const selected = currentChapter?.chapter_id === ch.chapter_id;
                return (
                    <div
                        key={ch.chapter_id}
                        onClick={() => { onSelectChapter(ch); onClose(); }}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm ${selected ? 'bg-zinc-50 text-zinc-800 font-medium' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50'}`}
                    >
                        <span className="truncate">{ch.title}</span>
                    </div>
                );
            });
        }
        const orderOfTitle = new Map(chapters.map((c, i) => [c.title, i]));
        const sortedToc = toc
            .filter(item => orderOfTitle.has(item.title))
            .sort((a, b) => orderOfTitle.get(a.title) - orderOfTitle.get(b.title));
        let chapterNum = 0;
        return sortedToc.map((item, i) => {
            const isL1 = (item.level || 1) === 1;
            if (isL1) chapterNum++;
            const ch = chapters.find(c => c.title === item.title);
            const selected = ch && currentChapter?.chapter_id === ch.chapter_id;
            return (
                <div
                    key={i}
                    onClick={() => { if (ch) { onSelectChapter(ch); onClose(); } }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm ${selected ? 'bg-zinc-50 text-zinc-800 font-medium' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50'} ${!isL1 ? 'pl-8' : ''}`}
                >
                    {isL1 ? (
                        <span className="text-zinc-400 text-xs min-w-[1.2em] tabular-nums">{chapterNum}.</span>
                    ) : (
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ml-0.5 ${selected ? 'bg-zinc-800' : 'bg-zinc-300'}`}></span>
                    )}
                    <span className="truncate">{item.title}</span>
                </div>
            );
        });
    };

    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className="fixed left-0 top-0 bottom-0 z-50 w-72 bg-white border-r border-zinc-200 shadow-2xl flex flex-col" style={{ animation: 'fade-in 0.2s ease-out' }}>
                <div className="px-4 pt-4 pb-2 flex-shrink-0">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-serif-heading font-semibold text-zinc-800 truncate">{book.title}</h3>
                        <button onClick={onClose} className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-50 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div className="relative mb-2">
                        <input
                            type="text"
                            value={keyword}
                            onChange={e => { setKeyword(e.target.value); runSearch(e.target.value); }}
                            placeholder="搜索本书"
                            className="w-full px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 placeholder:text-zinc-400"
                        />
                        {searching && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2">
                                <div className="animate-spin h-3 w-3 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                            </div>
                        )}
                    </div>
                    {results !== null && (
                        <button onClick={() => { setKeyword(''); setResults(null); }} className="text-[11px] text-zinc-400 hover:text-zinc-600 mb-1">
                            ← 返回目录（{results.length} 条结果）
                        </button>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-3 space-y-0.5">
                    {renderToc()}
                </div>
                {book.summary && results === null && (
                    <div className="flex-shrink-0 border-t border-zinc-100 px-4 py-3 max-h-40 overflow-y-auto scrollbar-thin">
                        <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">书籍摘要</p>
                        <p className="text-xs text-zinc-500 leading-relaxed">{book.summary}</p>
                    </div>
                )}
            </div>
        </>
    );
}

// 书内三区布局：[会话侧栏 | 阅读区 | AI区]；目录/工具/收藏均为顶栏唤出的满高抽屉
function BookReader({
    currentBook, currentChapter, onSelectChapter, onBackToShelf,
    // 会话
    sessions, currentSessionId, onNewSession, onSelectSession, onDeleteSession,
    // 对话与工具
    messages, isStreaming, busyToolId, onSendMessage, onRunTool,
    favorites, onToggleFavorite, onRemoveFavorite, onNavigateToSource,
    // 专家
    experts, activeExpert, expertOpening, onOpenExpert, onGenerateReport,
    // AI 区开合（App 持有，发消息等操作会自动展开）
    aiOpen, setAiOpen,
}) {
    const [railOpen, setRailOpen] = useState(() => {
        try { return JSON.parse(localStorage.getItem('reader_ui') || '{}').railOpen ?? window.innerWidth >= 1440; }
        catch { return window.innerWidth >= 1440; }
    });
    const [toolOpen, setToolOpen] = useState(false);
    const [favOpen, setFavOpen] = useState(false);
    const [tocOpen, setTocOpen] = useState(false);

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem('reader_ui') || '{}');
            localStorage.setItem('reader_ui', JSON.stringify({ ...saved, railOpen }));
        } catch { /* 隐私模式等场景忽略 */ }
    }, [railOpen]);

    const scopeLabel = currentChapter ? currentChapter.title : '整本书';
    const streamBusy = isStreaming;

    return (
        <div className="h-screen flex flex-col overflow-hidden bg-zinc-50">
            {/* 顶栏 */}
            <div className="h-12 px-4 flex items-center gap-3 flex-shrink-0">
                <button
                    onClick={onBackToShelf}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-700 hover:bg-white transition-all"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    书架
                </button>
                <div className="h-4 w-px bg-zinc-200 flex-shrink-0"></div>
                <h1 className="text-sm font-serif-heading font-semibold text-zinc-800 truncate">
                    {currentBook?.title || '智能读书助手'}
                </h1>
                {currentBook?.author && (
                    <span className="text-[11px] text-zinc-300 truncate flex-shrink-0">{currentBook.author}</span>
                )}

                <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                    <ToggleButton active={tocOpen} onClick={() => setTocOpen(o => !o)} label="目录">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                        </svg>
                    </ToggleButton>
                    <ToggleButton active={railOpen} onClick={() => setRailOpen(o => !o)} label="会话">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                    </ToggleButton>
                    <ToggleButton active={aiOpen} onClick={() => setAiOpen(o => !o)} label="AI">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </ToggleButton>
                    <ToggleButton active={toolOpen} onClick={() => setToolOpen(o => !o)} label="工具">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    </ToggleButton>
                    <ToggleButton active={favOpen} onClick={() => setFavOpen(o => !o)} label="收藏" badge={favorites.length}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                        </svg>
                    </ToggleButton>
                </div>
            </div>

            {/* 三区主体 */}
            <div className="flex-1 flex overflow-hidden px-3 pb-3 gap-2.5 min-h-0">
                <SessionRail
                    open={railOpen}
                    onToggle={() => setRailOpen(o => !o)}
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    onNewSession={onNewSession}
                    onSelectSession={onSelectSession}
                    onDeleteSession={onDeleteSession}
                    experts={experts}
                    disabled={streamBusy}
                />
                <ReadingPane
                    currentBook={currentBook}
                    currentChapter={currentChapter}
                    onSelectChapter={onSelectChapter}
                />
                <AiPanel
                    open={aiOpen}
                    onToggle={() => setAiOpen(o => !o)}
                    currentBook={currentBook}
                    messages={messages}
                    isStreaming={isStreaming}
                    onSendMessage={onSendMessage}
                    favorites={favorites}
                    onToggleFavorite={onToggleFavorite}
                    onNavigateToSource={onNavigateToSource}
                    experts={experts}
                    activeExpert={activeExpert}
                    expertOpening={expertOpening}
                    onOpenExpert={onOpenExpert}
                    onGenerateReport={onGenerateReport}
                    currentSessionId={currentSessionId}
                    onNewSession={onNewSession}
                />
            </div>

            {toolOpen && currentBook && (
                <ToolDrawer
                    disabled={streamBusy || !currentBook}
                    busyToolId={busyToolId}
                    onRunTool={onRunTool}
                    scopeLabel={scopeLabel}
                    onClose={() => setToolOpen(false)}
                />
            )}
            {favOpen && (
                <FavoritesDrawer
                    favorites={favorites}
                    onRemoveFavorite={onRemoveFavorite}
                    onClose={() => setFavOpen(false)}
                />
            )}
            {tocOpen && currentBook && (
                <TocDrawer
                    book={currentBook}
                    currentChapter={currentChapter}
                    onSelectChapter={onSelectChapter}
                    onClose={() => setTocOpen(false)}
                />
            )}
        </div>
    );
}

export default BookReader;
