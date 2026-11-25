import { useState } from 'react';

// 翻卡复习卡组（v2.3）：书架复习页与书内卡片抽屉共用
// 正面回忆 → 翻开对照 → 三档评分（Leitner：忘了=回1盒 / 记住了=+1 / 很熟=+2）
const BOX_DAYS = [1, 2, 4, 7, 15];

export default function ReviewDeck({ cards, onGrade, onFinish }) {
    const [idx, setIdx] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [doneCount, setDoneCount] = useState(0);

    if (!cards.length) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg className="w-10 h-10 text-zinc-200 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <p className="text-sm text-zinc-400 dark:text-zinc-500">这个队列现在是空的</p>
            </div>
        );
    }

    if (idx >= cards.length) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <svg className="w-12 h-12 text-emerald-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">本轮复习完成 · 共 {doneCount} 张</p>
                <button onClick={onFinish} className="mt-4 px-5 py-2 rounded-full bg-zinc-800 dark:bg-zinc-700 text-white text-sm font-medium hover:bg-zinc-900 dark:hover:bg-zinc-600 transition-all">
                    返回
                </button>
            </div>
        );
    }

    const card = cards[idx];
    const grade = (result) => {
        onGrade?.(card.card_id, result);
        const next = idx + 1;
        setDoneCount(c => c + 1);
        setFlipped(false);
        setIdx(next);
        if (next >= cards.length) setTimeout(() => onFinish?.(), 0);
    };

    const previewDays = (result) => {
        const cur = card.box || 1;
        const nb = result === 'again' ? 1 : result === 'good' ? Math.min(cur + 1, 5) : Math.min(cur + 2, 5);
        return BOX_DAYS[nb - 1];
    };
    const gradeBtn = (result, label, cls) => (
        <button onClick={() => grade(result)} className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all ${cls}`}>
            {label}<span className="block text-[10px] font-normal opacity-60 mt-0.5">{previewDays(result)} 天后</span>
        </button>
    );

    return (
        <div data-review-deck>
            <div className="flex items-center justify-between mb-2 px-0.5">
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums" data-review-progress>
                    {idx + 1} / {cards.length}
                </span>
                <span className="text-[11px] text-zinc-300">第 {card.box || 1} 盒</span>
            </div>

            {/* 卡片本体：点击翻面 */}
            <div
                data-review-card
                onClick={() => setFlipped(f => !f)}
                className="min-h-[220px] cursor-pointer rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm px-5 py-5 flex flex-col transition-all hover:shadow-md"
            >
                {!flipped ? (
                    <>
                        <p className="text-base text-zinc-900 dark:text-zinc-100 leading-relaxed font-medium flex-1" data-review-front>{card.front}</p>
                        <p className="text-[11px] text-zinc-300 mt-3 text-center">
                            {[card.chapter_title].filter(Boolean).join(' · ')}{card.chapter_title ? ' — ' : ''}点击显示答案
                        </p>
                    </>
                ) : (
                    <>
                        <p className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed flex-1" data-review-back>{card.back}</p>
                        {card.cite && (
                            <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500 italic border-l-2 border-zinc-100 dark:border-zinc-800 pl-2.5 leading-relaxed">「{card.cite}」</p>
                        )}
                        <p className="text-[11px] text-zinc-300 mt-2">{card.chapter_title ? `《${card.chapter_title}》` : ''}</p>
                    </>
                )}
            </div>

            {flipped ? (
                <div className="flex gap-2 mt-3">
                    {gradeBtn('again', '忘了', 'bg-red-50 dark:bg-red-500/10 text-red-500 dark:text-red-400 border-red-100 dark:border-red-500/30 hover:bg-red-100 dark:hover:bg-red-500/20')}
                    {gradeBtn('good', '记住了', 'bg-zinc-50 dark:bg-zinc-950 text-zinc-700 dark:text-zinc-200 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800')}
                    {gradeBtn('easy', '很熟', 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/30 hover:bg-emerald-100 dark:hover:bg-emerald-500/20')}
                </div>
            ) : (
                <button onClick={() => setFlipped(true)} className="w-full mt-3 py-2.5 rounded-xl bg-zinc-800 dark:bg-zinc-700 text-white text-sm font-medium hover:bg-zinc-900 dark:hover:bg-zinc-600 transition-all">
                    显示答案
                </button>
            )}
        </div>
    );
}
