import { useState, useRef, useEffect } from 'react';
import { TOOLS, TOOL_NEEDS_INPUT } from '../tools.js';

// 收藏夹抽屉（自旧 AI 工具面板迁移：勾选导出 + 删除）
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
            <div className="fixed top-14 bottom-3 right-14 z-50 w-80 bg-white rounded-2xl border border-zinc-200 shadow-2xl flex flex-col overflow-hidden animate-fade-in">
                <div className="px-4 pt-4 pb-3 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
                    <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
                        收藏{favorites.length > 0 && <span className="ml-1.5 text-zinc-300 normal-case">({favorites.length})</span>}
                    </h3>
                    <div className="flex items-center gap-2">
                        {selected.length > 0 && (
                            <button onClick={exportSelected} className="text-xs text-zinc-500 hover:text-zinc-700 font-medium">
                                导出选中
                            </button>
                        )}
                        <button onClick={onClose} className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-50 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>
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

// 工具侧栏：36px 图标细栏（常驻）；点击图标即运行并落进对话流
function ToolRail({ disabled, busyToolId, favorites, onRemoveFavorite, onRunTool, scopeLabel }) {
    const [talkOpen, setTalkOpen] = useState(false);
    const [talkInput, setTalkInput] = useState('');
    const [favOpen, setFavOpen] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        if (talkOpen) setTimeout(() => inputRef.current?.focus(), 50);
    }, [talkOpen]);

    const handleToolClick = (tool) => {
        if (disabled) return;
        if (TOOL_NEEDS_INPUT[tool.id]) {
            setTalkOpen(o => !o);
        } else {
            onRunTool(tool.id, null);
        }
    };

    const submitTalk = () => {
        if (!talkInput.trim()) return;
        onRunTool('author-talk', talkInput.trim());
        setTalkInput('');
        setTalkOpen(false);
    };

    return (
        <>
            <div className="w-9 flex-shrink-0 bg-white rounded-2xl border border-zinc-200 flex flex-col items-center py-2 gap-0.5">
                <span className="text-[10px] text-zinc-300 select-none mb-0.5">AI</span>
                {TOOLS.map(tool => {
                    const busy = busyToolId === tool.id;
                    return (
                        <button
                            key={tool.id}
                            onClick={() => handleToolClick(tool)}
                            disabled={disabled}
                            className={`relative p-1.5 rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed ${busy ? 'bg-zinc-800 text-white' : (TOOL_NEEDS_INPUT[tool.id] && talkOpen ? 'bg-zinc-100 text-zinc-700' : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50')}`}
                            title={`${tool.label} · ${scopeLabel}`}
                        >
                            <svg className={`w-4 h-4 ${busy ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tool.icon} />
                            </svg>
                        </button>
                    );
                })}
                <div className="flex-1" />
                <button
                    onClick={() => setFavOpen(o => !o)}
                    className={`relative p-1.5 rounded-lg transition-all ${favOpen ? 'bg-zinc-100 text-zinc-700' : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50'}`}
                    title="收藏"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                    {favorites.length > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-zinc-700 text-white text-[9px] leading-[14px] text-center tabular-nums">
                            {favorites.length > 99 ? '99+' : favorites.length}
                        </span>
                    )}
                </button>
            </div>

            {/* 与作者对谈：输入弹层 */}
            {talkOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setTalkOpen(false)} />
                    <div className="fixed bottom-3 right-14 z-50 w-80 bg-white rounded-2xl border border-zinc-200 shadow-2xl p-4 animate-fade-in">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-semibold text-zinc-700">与作者对谈</h3>
                            <span className="text-[11px] text-zinc-300 truncate ml-2">{scopeLabel}</span>
                        </div>
                        <div className="flex gap-2">
                            <input
                                ref={inputRef}
                                type="text"
                                value={talkInput}
                                onChange={e => setTalkInput(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTalk(); } }}
                                placeholder="向作者提问"
                                className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-400"
                            />
                            <button
                                onClick={submitTalk}
                                disabled={!talkInput.trim() || disabled}
                                className="px-4 py-2 bg-zinc-800 text-white rounded-full text-sm font-medium hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
                            >
                                提问
                            </button>
                        </div>
                    </div>
                </>
            )}

            {favOpen && (
                <FavoritesDrawer
                    favorites={favorites}
                    onRemoveFavorite={onRemoveFavorite}
                    onClose={() => setFavOpen(false)}
                />
            )}
        </>
    );
}

export default ToolRail;
