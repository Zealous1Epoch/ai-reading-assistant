import { useState } from 'react';

// 收藏抽屉：顶栏「收藏」唤出（右侧满高，与工具抽屉同款）；勾选导出 + 删除
function FavoritesDrawer({ favorites, onRemoveFavorite, onClose }) {
    const [selected, setSelected] = useState([]);
    const toggle = (id) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

    const exportSelected = () => {
        const toExport = favorites.filter(f => selected.includes(f.id));
        if (toExport.length === 0) { alert('请先勾选要导出的收藏'); return; }
        const content = toExport.map(f => {
            const header = f.type === 'tool' ? `=== AI工具 · ${f.toolLabel || '未知'} ===` : '=== 收藏问答 ===';
            return `${header}\n保存时间: ${f.savedAt || '未知'}\n\n问: ${f.question}\n\n答: ${f.answer}\n\n---\n`;
        }).join('\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `收藏_${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className="fixed right-0 top-0 bottom-0 z-50 w-72 bg-white border-l border-zinc-200 shadow-2xl flex flex-col" style={{ animation: 'fade-in 0.2s ease-out' }}>
                {/* 标题栏 */}
                <div className="px-4 pt-4 pb-3 border-b border-zinc-100 flex items-center gap-2 flex-shrink-0">
                    <h3 className="text-sm font-serif-heading font-semibold text-zinc-800">收藏</h3>
                    {favorites.length > 0 && (
                        <span className="text-[11px] text-zinc-400 tabular-nums">({favorites.length})</span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {selected.length > 0 && (
                            <button onClick={exportSelected} className="px-2.5 py-1 rounded-lg bg-zinc-800 text-white text-[11px] font-medium hover:bg-zinc-900 transition-all">
                                导出 {selected.length}
                            </button>
                        )}
                        <button onClick={onClose} className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-50 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* 收藏列表 */}
                <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
                    {favorites.length === 0 ? (
                        <div className="text-center py-10">
                            <svg className="w-8 h-8 mx-auto text-zinc-200 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                            </svg>
                            <p className="text-xs text-zinc-300">暂无收藏</p>
                        </div>
                    ) : favorites.map(fav => (
                        <div
                            key={fav.id}
                            onClick={() => toggle(fav.id)}
                            className={`group rounded-xl border p-3 cursor-pointer transition-all ${selected.includes(fav.id) ? 'border-zinc-300 bg-zinc-50' : 'border-zinc-100 hover:border-zinc-200'}`}
                        >
                            <div className="flex items-start gap-2">
                                <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${selected.includes(fav.id) ? 'bg-zinc-800 border-zinc-800' : 'border-zinc-300'}`}>
                                    {selected.includes(fav.id) && (
                                        <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                        </svg>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                        {fav.type === 'tool' && fav.toolLabel && (
                                            <span className="text-[10px] px-1.5 py-0.5 bg-zinc-100 text-zinc-500 rounded-full flex-shrink-0">{fav.toolLabel}</span>
                                        )}
                                        <p className="text-xs font-medium text-zinc-700 truncate">{fav.question}</p>
                                    </div>
                                    <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">{fav.answer}</p>
                                    {fav.savedAt && <p className="text-[10px] text-zinc-300 mt-1">{fav.savedAt}</p>}
                                </div>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onRemoveFavorite(fav.id); }}
                                    className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-300 hover:text-red-500 transition-all flex-shrink-0"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

export default FavoritesDrawer;
