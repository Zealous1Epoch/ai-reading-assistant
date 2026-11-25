import { useState, useEffect, useCallback } from 'react';
import ReviewDeck from './ReviewDeck.jsx';

// 书内卡片弹层（v3.2）：由右侧满高抽屉改为顶栏「卡片」按钮下方弹出（调用方给 relative 容器）。
// 按钮在顶栏右缘，弹层 right-0 锚定向左展开，避免越出屏幕右缘；内容区上下滚动。
// 今日复习队列 / 随机测验 / 卡列表管理 + Anki 导出；data-cards-* 钩子与 E2E 契约原样保留
export default function CardsMenu({ bookId, bookTitle, onClose, onStatsChanged }) {
    const [tab, setTab] = useState('due');            // due | quiz | list
    const [cards, setCards] = useState(null);
    const [round, setRound] = useState(0);
    const [total, setTotal] = useState(null);   // null=未加载：加载前不渲染计数，避免 (0) 闪现与断言竞态
    const [due, setDue] = useState(0);

    const q = `book_id=${encodeURIComponent(bookId)}`;

    const refreshStats = useCallback(() => {
        fetch(`/cards?${q}`).then(r => r.json()).then(d => setTotal(d.total || 0)).catch(() => {});
        fetch(`/cards/due?${q}`).then(r => r.json()).then(d => setDue(d.total || 0)).catch(() => {});
    }, [q]);

    useEffect(() => { refreshStats(); }, [refreshStats]);

    useEffect(() => {
        if (tab === 'list') {
            fetch(`/cards?${q}`).then(r => r.json()).then(d => setCards(d.cards || [])).catch(() => setCards([]));
            return;
        }
        if (tab === null) return;
        setCards(null);
        const src = tab === 'due' ? `/cards/due?${q}` : `/cards?${q}`;
        fetch(src).then(r => r.json()).then(d => {
            let list = d.cards || [];
            if (tab === 'quiz') {
                list = list.slice();
                for (let i = list.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [list[i], list[j]] = [list[j], list[i]];
                }
                list = list.slice(0, 10);
            }
            setCards(list);
        }).catch(() => setCards([]));
    }, [tab, q, round]);

    const grade = (cardId, result) => {
        fetch(`/cards/${cardId}/grade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result }),
        }).then(r => { if (r.ok) { refreshStats(); onStatsChanged?.(); } })
          .catch(() => {});
    };

    const removeCard = (cardId) => {
        fetch(`/cards/${cardId}`, { method: 'DELETE' })
            .then(r => { if (r.ok) { setCards(prev => (prev || []).filter(c => c.card_id !== cardId)); refreshStats(); onStatsChanged?.(); } })
            .catch(() => {});
    };

    const tabBtn = (id, label, badgeN) => (
        <button
            onClick={() => { setTab(id); setRound(r => r + 1); }}
            className={`px-3 py-1.5 rounded-[10px] text-xs font-medium transition-all ${tab === id ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'}`}
            data-cards-tab={id}
        >
            {label}{badgeN > 0 ? ` (${badgeN})` : ''}
        </button>
    );

    return (
        <>
            <div className="fixed inset-0 z-30" onClick={onClose} />
            <div
                data-cards-menu
                className="absolute top-full right-0 mt-2 z-40 w-96 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg flex flex-col overflow-hidden"
                style={{ animation: 'fade-in 0.2s ease-out', maxWidth: 'calc(100vw - 32px)' }}
            >
                {/* 标题栏 */}
                <div className="px-3.5 pt-3 pb-2 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2 flex-shrink-0">
                    <h3 className="text-sm font-serif-heading font-semibold text-zinc-800 dark:text-zinc-200">卡片</h3>
                    {total !== null && (
                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums" data-cards-count>({total})</span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {total > 0 && (
                            <a
                                href={`/cards/export/anki?${q}`}
                                download
                                className="px-2.5 py-1 rounded-lg bg-zinc-800 dark:bg-zinc-700 text-white text-[11px] font-medium hover:bg-zinc-900 dark:hover:bg-zinc-600 transition-all"
                                data-cards-export="anki"
                            >
                                导出 Anki
                            </a>
                        )}
                        <button onClick={onClose} className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-all" title="关闭">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* 模式切换 */}
                <div className="px-3.5 pt-2.5 pb-2 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
                    <div className="inline-flex rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5">
                        {tabBtn('due', '今日复习', due)}
                        {tabBtn('quiz', '随机测验', null)}
                        {tabBtn('list', '列表', null)}
                    </div>
                </div>

                <div className="max-h-[62vh] overflow-y-auto scrollbar-thin p-3.5">
                    {tab === 'list' ? (
                        cards === null ? <div className="text-center text-xs text-zinc-300 py-10">载入中…</div> : (
                            <div className="space-y-2">
                                {cards.length === 0 && <p className="text-xs text-zinc-300 text-center py-10">暂无卡片</p>}
                                {cards.map(c => (
                                    <div key={c.card_id} className="group rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 px-3.5 py-2.5">
                                        <div className="flex items-start gap-2">
                                            <p className="text-xs text-zinc-700 dark:text-zinc-200 leading-relaxed flex-1">{c.front}</p>
                                            <button
                                                onClick={() => removeCard(c.card_id)}
                                                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-zinc-300 hover:text-red-400 transition-all flex-shrink-0"
                                                title="删除卡片"
                                            >
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                                            <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 tabular-nums">第 {c.box || 1} 盒</span>
                                            <span className="tabular-nums">{c.next_review} 复习</span>
                                            {c.chapter_title && <span className="truncate">{c.chapter_title}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )
                    ) : cards === null ? (
                        <div className="text-center text-xs text-zinc-300 py-12">载入中…</div>
                    ) : (
                        <ReviewDeck
                            key={`${tab}-${round}-${cards.length}`}
                            cards={cards}
                            onGrade={grade}
                            onFinish={() => setRound(r => r + 1)}
                        />
                    )}
                </div>
            </div>
        </>
    );
}
