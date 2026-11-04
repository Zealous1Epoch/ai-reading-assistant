import { useState, useEffect } from 'react';
import TocRail from './TocRail.jsx';
import SessionDrawer from './SessionDrawer.jsx';
import ReadingPane from './ReadingPane.jsx';
import AiPanel from './AiPanel.jsx';
import ToolDrawer from './ToolDrawer.jsx';
import FavoritesDrawer from './FavoritesDrawer.jsx';

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

// 书内三区布局：[目录侧栏 | 阅读区 | AI区]；会话/工具/收藏均为顶栏唤出的满高抽屉
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
    // 目录侧栏开合（持久化；旧键 railOpen 曾是会话侧栏，作一次性回落）
    const [tocOpen, setTocOpen] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem('reader_ui') || '{}');
            return saved.tocRailOpen ?? saved.railOpen ?? window.innerWidth >= 1440;
        } catch { return window.innerWidth >= 1440; }
    });
    const [sessionOpen, setSessionOpen] = useState(false);
    const [toolOpen, setToolOpen] = useState(false);
    const [favOpen, setFavOpen] = useState(false);
    // 工具作用范围：默认当前章；「整本书」供全书思维导图/总结等使用（瞬时态，不持久化）
    const [toolScopeAll, setToolScopeAll] = useState(false);

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem('reader_ui') || '{}');
            const { railOpen, ...rest } = saved;
            localStorage.setItem('reader_ui', JSON.stringify({ ...rest, tocRailOpen: tocOpen }));
        } catch { /* 隐私模式等场景忽略 */ }
    }, [tocOpen]);

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
                    <ToggleButton active={sessionOpen} onClick={() => setSessionOpen(o => !o)} label="会话" badge={sessions.length}>
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
                {currentBook && (
                    <TocRail
                        book={currentBook}
                        currentChapter={currentChapter}
                        onSelectChapter={onSelectChapter}
                        open={tocOpen}
                        onToggle={() => setTocOpen(o => !o)}
                    />
                )}
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

            {sessionOpen && (
                <SessionDrawer
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    onNewSession={onNewSession}
                    onSelectSession={onSelectSession}
                    onDeleteSession={onDeleteSession}
                    experts={experts}
                    disabled={streamBusy}
                    onClose={() => setSessionOpen(false)}
                />
            )}
            {toolOpen && currentBook && (
                <ToolDrawer
                    disabled={streamBusy || !currentBook}
                    busyToolId={busyToolId}
                    onRunTool={onRunTool}
                    scopeLabel={scopeLabel}
                    scopeAll={toolScopeAll}
                    onScopeChange={setToolScopeAll}
                    hasChapter={!!currentChapter}
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
        </div>
    );
}

export default BookReader;
