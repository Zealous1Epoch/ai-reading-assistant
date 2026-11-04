import { useState, useEffect, useCallback } from 'react';
import ReviewDeck from './ReviewDeck.jsx';

const API_BASE = '';

// 复习页（v2.3，#/review）：全库/按书 到期队列 + 随机测验
export default function ReviewPage({ books, onBack, onStatsChanged }) {
    const [bookId, setBookId] = useState('');          // '' = 全部
    const [mode, setMode] = useState('due');           // due | quiz
    const [cards, setCards] = useState(null);          // null=加载中
    const [round, setRound] = useState(0);             // 重新取队列的轮次键
    const [statsTot, setStatsTot] = useState({ total: 0, due: 0 });

    const bookName = useCallback((id) => {
        const b = books.find(x => x.book_id === id);
        return b ? b.title : '某本书';
    }, [books]);

    useEffect(() => {
        let dead = false;
        setCards(null);
        const q = bookId ? `?book_id=${encodeURIComponent(bookId)}` : '';
        if (mode === 'due') {
            fetch(`${API_BASE}/cards/due${q}`)
                .then(r => r.json())
                .then(d => { if (!dead) setCards(d.cards || []); });
        } else {
            fetch(`${API_BASE}/cards${q}`)
                .then(r => r.json())
                .then(d => {
                    if (dead) return;
                    const all = (d.cards || []).slice();
                    for (let i = all.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [all[i], all[j]] = [all[j], all[i]];
                    }
                    setCards(all.slice(0, 10));
                });
        }
        fetch(`${API_BASE}/cards/stats`).then(r => r.json())
            .then(s => { if (!dead) { setStatsTot({ total: s.total, due: s.due }); onStatsChanged?.(s); } })
            .catch(() => {});
        return () => { dead = true; };
    }, [bookId, mode, round, onStatsChanged]);

    const grade = (cardId, result) => {
        fetch(`${API_BASE}/cards/${cardId}/grade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result }),
        }).then(r => { if (!r.ok) console.warn('卡片评分落盘失败', r.status); })
          .catch(e => console.warn('卡片评分落盘失败', e));
        setStatsTot(s => ({
            ...s,
            due: result === 'again' ? s.due : Math.max(0, s.due - 1),
        }));
    };

    const tabs = [{ id: '', name: '全部' }].concat(books.filter(b => true).map(b => ({ id: b.book_id, name: b.title })));

    return (
        <div className="h-screen flex flex-col bg-zinc-50 overflow-hidden">
            {/* 顶栏 */}
            <div className="h-12 px-4 flex items-center gap-3 flex-shrink-0">
                <button onClick={onBack} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-700 hover:bg-white transition-all">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    书架
                </button>
                <div className="h-4 w-px bg-zinc-200 flex-shrink-0"></div>
                <h1 className="text-sm font-serif-heading font-semibold text-zinc-800">复习卡片</h1>
                <span className="text-[11px] text-zinc-300 tabular-nums">
                    {statsTot.due} 张到期 / 共 {statsTot.total} 张
                </span>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-8">
                <div className="max-w-xl mx-auto">
                    {/* 书筛选 tabs */}
                    <div className="flex flex-wrap gap-1.5 mt-2 mb-3">
                        {tabs.map(t => (
                            <button
                                key={t.id || 'all'}
                                onClick={() => setBookId(t.id)}
                                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${bookId === t.id
                                    ? 'bg-zinc-800 text-white border-zinc-800'
                                    : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400'}`}
                            >
                                {t.name.length > 8 ? t.name.slice(0, 8) + '…' : t.name}
                            </button>
                        ))}
                    </div>
                    {/* 模式切换 */}
                    <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-0.5 mb-4">
                        {[['due', '今日到期'], ['quiz', '随机测验']].map(([m, label]) => (
                            <button
                                key={m}
                                onClick={() => setMode(m)}
                                className={`px-4 py-1.5 rounded-[10px] text-xs font-medium transition-all ${mode === m ? 'bg-zinc-100 text-zinc-800' : 'text-zinc-400 hover:text-zinc-600'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="rounded-2xl border border-zinc-100 bg-white/60 px-4 py-4">
                        {cards === null ? (
                            <div className="py-16 text-center text-sm text-zinc-300">载入中…</div>
                        ) : (
                            <ReviewDeck
                                key={`${bookId}-${mode}-${round}-${cards.length}`}
                                cards={cards}
                                onGrade={grade}
                                onFinish={() => { setRound(r => r + 1); }}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
