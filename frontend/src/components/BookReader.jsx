import { useState, useEffect } from 'react';
import TocRail from './TocRail.jsx';
import SessionMenu from './SessionMenu.jsx';
import ReadingPane from './ReadingPane.jsx';
import AiPanel from './AiPanel.jsx';
import AssetsDrawer from './AssetsDrawer.jsx';
import CardsMenu from './CardsMenu.jsx';

function ToggleButton({ active, onClick, label, badge, children }) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${active ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}
            title={label}
        >
            {children}
            <span>{label}</span>
            {badge > 0 && (
                <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 text-[9px] leading-[15px] text-center tabular-nums">
                    {badge > 99 ? '99+' : badge}
                </span>
            )}
        </button>
    );
}

// v3.1 三区宽度可拖拽自定义：阅读区吃剩余空间，两侧栏宽由 BookReader 持有并持久化
const DEFAULT_TOC_W = 216;
const DEFAULT_AI_W = 400;
const clampW = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampTocW = v => clampW(Math.round(v), 150, 420);
const clampAiW = v => clampW(Math.round(v), 320, 760);

// 拖拽手柄：叠在栏间缝隙上（负 margin 不占额外宽度），双击恢复默认
function ResizeHandle({ side, onPointerDown, onDoubleClick }) {
    return (
        <div
            data-resize={side}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
            title="拖动调整宽度 · 双击恢复默认"
            className="group relative w-2 -mx-1 flex-shrink-0 z-10 self-stretch flex items-center justify-center cursor-col-resize"
            style={{ touchAction: 'none' }}
        >
            <div className="h-12 w-[3px] rounded-full bg-zinc-200 dark:bg-zinc-700 group-hover:bg-zinc-500 transition-colors pointer-events-none"></div>
        </div>
    );
}

// 书内三区布局：[目录侧栏 | 阅读区 | AI区]；会话/卡片=顶栏按钮处弹出小窗（v3.2），资产为满高抽屉，工具在 AI 面板 ➕ 里
function BookReader({
    currentBook, currentChapter, onSelectChapter, onBackToShelf,
    citeTarget,
    // 会话
    sessions, currentSessionId, onNewSession, onSelectSession, onDeleteSession,
    // 对话与工具
    messages, isStreaming, busyToolId, onSendMessage, onRunTool,
    favorites, onToggleFavorite, onRemoveFavorite, onNavigateToSource,
    // 专家
    experts, activeExpert, expertOpening, onOpenExpert, onGenerateReport,
    // AI 区开合（App 持有，发消息等操作会自动展开）
    aiOpen, setAiOpen,
    // 知识卡片（v2.3）：该书今日到期数 + 复习/删卡后的徽标刷新
    cardDue, onCardsStatsChanged,
    // v2.7 划线高亮 + 选区引用进对话
    highlights, onAddHighlights, onRemoveHighlight, onQuoteToChat, quoteDraft, onClearQuote,
    // v3.5 设置面板（App 持有单实例）
    onOpenSettings,
}) {
    const readSaved = () => {
        try { return JSON.parse(localStorage.getItem('reader_ui') || '{}'); } catch { return {}; }
    };
    // 目录侧栏开合（持久化；旧键 railOpen 曾是会话侧栏，作一次性回落）
    const [tocOpen, setTocOpen] = useState(() => readSaved().tocRailOpen ?? readSaved().railOpen ?? window.innerWidth >= 1440);
    const [sessionOpen, setSessionOpen] = useState(false);
    const [favOpen, setFavOpen] = useState(false);
    const [cardsOpen, setCardsOpen] = useState(false);
    // 工具作用范围：默认当前章；「整本书」供全书思维导图/总结等使用（瞬时态，不持久化）
    const [toolScopeAll, setToolScopeAll] = useState(false);
    // v3.1 两侧栏宽度（拖拽自定义，持久化；阅读区为剩余空间不设宽）
    const [paneW, setPaneW] = useState(() => ({
        toc: clampTocW(readSaved().tocWidth ?? DEFAULT_TOC_W),
        ai: clampAiW(readSaved().aiWidth ?? DEFAULT_AI_W),
    }));

    useEffect(() => {
        try {
            const saved = readSaved();
            const { railOpen, ...rest } = saved;
            localStorage.setItem('reader_ui', JSON.stringify({ ...rest, tocRailOpen: tocOpen, tocWidth: paneW.toc, aiWidth: paneW.ai }));
        } catch { /* 隐私模式等场景忽略 */ }
    }, [tocOpen, paneW]);

    // 拖宽：toc 手柄向右加宽、ai 手柄向左加宽；pointer 全局监听，结束后清理光标
    const startDrag = (which) => (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const start = paneW[which];
        const clamp = which === 'toc' ? clampTocW : clampAiW;
        const onMove = (ev) => {
            const delta = which === 'toc' ? ev.clientX - startX : startX - ev.clientX;
            setPaneW(p => ({ ...p, [which]: clamp(start + delta) }));
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
    };

    const scopeLabel = currentChapter ? currentChapter.title : '整本书';
    const streamBusy = isStreaming;

    return (
        <div className="h-screen flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
            {/* 顶栏：左=返回+书名/作者+目录/会话开关，右=AI/卡片/资产 */}
            <div className="h-12 px-4 flex items-center gap-3 flex-shrink-0">
                <button
                    onClick={onBackToShelf}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-white transition-all"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    书架
                </button>
                <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-700 flex-shrink-0"></div>
                <h1 className="text-sm font-serif-heading font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                    {currentBook?.title || '智能读书助手'}
                </h1>
                {currentBook?.author && (
                    <span className="text-[11px] text-zinc-300 truncate flex-shrink-0">{currentBook.author}</span>
                )}

                {/* v3.1：目录/会话开关紧跟书名，贴近各自区域 */}
                <ToggleButton active={tocOpen} onClick={() => setTocOpen(o => !o)} label="目录">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                    </svg>
                </ToggleButton>
                {/* v3.2：会话改为按钮下方弹出小窗（列表内上下滚动），不再占满全屏高 */}
                <div className="relative flex-shrink-0">
                    <ToggleButton active={sessionOpen} onClick={() => setSessionOpen(o => !o)} label="会话" badge={sessions.length}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                    </ToggleButton>
                    {sessionOpen && (
                        <SessionMenu
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
                </div>

                <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                    <ToggleButton active={aiOpen} onClick={() => setAiOpen(o => !o)} label="AI">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </ToggleButton>
                    {/* v3.2：卡片同样改为按钮弹层；按钮在右缘，弹层向右展开会出屏，改 right-0 向左开 */}
                    <div className="relative flex-shrink-0">
                        <ToggleButton active={cardsOpen} onClick={() => setCardsOpen(o => !o)} label="卡片" badge={cardDue}>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                        </ToggleButton>
                        {cardsOpen && currentBook && (
                            <CardsMenu
                                bookId={currentBook.book_id}
                                bookTitle={currentBook.title}
                                onClose={() => setCardsOpen(false)}
                                onStatsChanged={onCardsStatsChanged}
                            />
                        )}
                    </div>
                    <ToggleButton active={favOpen} onClick={() => setFavOpen(o => !o)} label="资产" badge={favorites.length}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                        </svg>
                    </ToggleButton>
                    {/* v3.5 设置齿轮：与 ToggleButton 同规格 */}
                    <button
                        onClick={onOpenSettings}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-all"
                        title="设置"
                        data-open-settings
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>设置</span>
                    </button>
                </div>
            </div>

            {/* 三区主体（两侧栏可拖拽改宽） */}
            <div className="flex-1 flex overflow-hidden px-3 pb-3 gap-2.5 min-h-0">
                {currentBook && (
                    <TocRail
                        book={currentBook}
                        currentChapter={currentChapter}
                        onSelectChapter={onSelectChapter}
                        open={tocOpen}
                        onToggle={() => setTocOpen(o => !o)}
                        width={paneW.toc}
                    />
                )}
                {currentBook && tocOpen && (
                    <ResizeHandle side="toc" onPointerDown={startDrag('toc')} onDoubleClick={() => setPaneW(w => ({ ...w, toc: DEFAULT_TOC_W }))} />
                )}
                <ReadingPane
                    currentBook={currentBook}
                    currentChapter={currentChapter}
                    onSelectChapter={onSelectChapter}
                    citeTarget={citeTarget}
                    highlights={highlights}
                    onAddHighlights={onAddHighlights}
                    onRemoveHighlight={onRemoveHighlight}
                    onQuoteToChat={onQuoteToChat}
                />
                {aiOpen && (
                    <ResizeHandle side="ai" onPointerDown={startDrag('ai')} onDoubleClick={() => setPaneW(w => ({ ...w, ai: DEFAULT_AI_W }))} />
                )}
                <AiPanel
                    open={aiOpen}
                    onToggle={() => setAiOpen(o => !o)}
                    width={paneW.ai}
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
                    quoteDraft={quoteDraft}
                    onClearQuote={onClearQuote}
                    onRunTool={onRunTool}
                    busyToolId={busyToolId}
                    toolScopeAll={toolScopeAll}
                    onToolScopeChange={setToolScopeAll}
                    scopeLabel={scopeLabel}
                    hasChapter={!!currentChapter}
                />
            </div>

            {favOpen && currentBook && (
                <AssetsDrawer
                    assets={favorites}
                    bookId={currentBook.book_id}
                    bookTitle={currentBook.title}
                    onRemove={onRemoveFavorite}
                    onNavigateToSource={onNavigateToSource}
                    onClose={() => setFavOpen(false)}
                />
            )}
        </div>
    );
}

export default BookReader;
