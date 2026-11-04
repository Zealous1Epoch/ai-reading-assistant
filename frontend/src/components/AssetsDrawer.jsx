import { useState } from 'react';
import { MindmapTree, parseMindmapJson } from './ToolMessageCard.jsx';

// 本书资产区抽屉（v2.4）：顶栏「资产」唤出（右侧满高，与工具/卡片同款镜像）
// 收藏从浏览器 localStorage 升级为后端资产——三类：文字（问答/摘录）/ AI 产出（含导图重放、HTML 预览）/ 报告
const TYPE_META = {
    qa: { label: '文字', cls: 'bg-zinc-100 text-zinc-500' },
    tool: { label: 'AI 产出', cls: 'bg-blue-50 text-blue-500' },
    report: { label: '报告', cls: 'bg-amber-50 text-amber-600' },
};

function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

function AssetsDrawer({ assets, bookId, bookTitle, onClose, onRemove, onNavigateToSource }) {
    const [type, setType] = useState(null);     // null=全部
    const [q, setQ] = useState('');
    const [expandedId, setExpandedId] = useState(null);

    const ql = q.trim().toLowerCase();
    const visible = (assets || []).filter(a =>
        (!type || a.type === type) &&
        (!ql || ((a.question || '') + '\n' + (a.answer || '')).toLowerCase().includes(ql))
    );

    const chip = (id, label) => (
        <button
            key={id ?? 'all'}
            onClick={() => setType(id)}
            data-assets-tab={id ?? 'all'}
            className={`px-2.5 py-1 rounded-[10px] text-[11px] font-medium transition-all ${type === id ? 'bg-zinc-100 text-zinc-800' : 'text-zinc-400 hover:text-zinc-600'}`}
        >{label}</button>
    );

    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className="fixed right-0 top-0 bottom-0 z-50 w-96 bg-white border-l border-zinc-200 shadow-2xl flex flex-col" style={{ animation: 'fade-in 0.2s ease-out' }}>
                {/* 标题栏 */}
                <div className="px-4 pt-4 pb-3 border-b border-zinc-100 flex items-center gap-2 flex-shrink-0">
                    <h3 className="text-sm font-serif-heading font-semibold text-zinc-800">资产区</h3>
                    {Array.isArray(assets) && (
                        <span className="text-[11px] text-zinc-400 tabular-nums" data-assets-count>({assets.length})</span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {(assets || []).length > 0 && (
                            <a
                                href={`/assets/export?book_id=${encodeURIComponent(bookId)}`}
                                download
                                className="px-2.5 py-1 rounded-lg bg-zinc-800 text-white text-[11px] font-medium hover:bg-zinc-900 transition-all"
                                data-assets-export="md"
                            >导出</a>
                        )}
                        <button onClick={onClose} title="关闭" className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-50 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* 搜索 + 类型筛选 */}
                <div className="px-4 pt-3 space-y-2 flex-shrink-0">
                    <input
                        value={q}
                        onChange={e => setQ(e.target.value)}
                        placeholder="搜索资产"
                        className="w-full px-3 py-1.5 rounded-xl border border-zinc-200 text-xs focus:outline-none focus:border-zinc-400"
                    />
                    <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-0.5">
                        {chip(null, '全部')}
                        {chip('qa', '文字')}
                        {chip('tool', 'AI 产出')}
                        {chip('report', '报告')}
                    </div>
                </div>

                {/* 列表 */}
                <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-2">
                    {visible.length === 0 && (
                        <p className="text-xs text-zinc-300 text-center py-10">还没有资产</p>
                    )}
                    {visible.map(a => {
                        const meta = TYPE_META[a.type] || TYPE_META.qa;
                        const open = expandedId === a.id;
                        const mm = open && a.type === 'tool' && a.outputType === 'mindmap' ? parseMindmapJson(a.answer) : null;
                        return (
                            <div key={a.id} className="group rounded-xl border border-zinc-100 bg-zinc-50/50 transition-all" data-asset-item>
                                <div
                                    className="px-3.5 py-2.5 cursor-pointer flex items-start gap-2"
                                    onClick={() => setExpandedId(open ? null : a.id)}
                                >
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${meta.cls}`}>
                                        {a.type === 'tool' && a.toolLabel ? a.toolLabel : meta.label}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium text-zinc-700 truncate">{a.question || '收藏'}</p>
                                        {!open && <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-1">{a.answer}</p>}
                                    </div>
                                    <span className="text-[10px] text-zinc-300 flex-shrink-0 tabular-nums mt-0.5">
                                        {(a.savedAt || '').slice(5, 10)}
                                    </span>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
                                        className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-300 hover:text-red-500 transition-all flex-shrink-0"
                                        title="移除资产"
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                </div>

                                {open && (
                                    <div className="px-3.5 pb-3">
                                        {mm ? (
                                            <div className="bg-white rounded-lg border border-zinc-100 p-2">
                                                <MindmapTree
                                                    root={mm}
                                                    bookId={bookId}
                                                    onNavigateToSource={(bid, cid) => { onNavigateToSource?.(bid, cid); onClose(); }}
                                                />
                                            </div>
                                        ) : a.type === 'tool' && a.outputType === 'audio' ? (
                                            <audio controls preload="metadata" src={a.answer} className="w-full" data-asset-audio={a.id} />
                                        ) : a.type === 'tool' && a.outputType === 'html' ? (
                                            <iframe
                                                title={a.question}
                                                srcDoc={a.answer}
                                                className="w-full h-64 rounded-lg border border-zinc-200 bg-white"
                                                sandbox=""
                                            />
                                        ) : (
                                            <div className="max-h-60 overflow-y-auto scrollbar-thin text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap bg-white rounded-lg border border-zinc-100 p-3">
                                                {a.answer}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-3 mt-2">
                                            <button
                                                onClick={() => navigator.clipboard?.writeText(a.answer || '')}
                                                className="text-[11px] text-zinc-400 hover:text-zinc-600"
                                            >复制</button>
                                            <button
                                                onClick={() => downloadText(`${(a.question || '资产').slice(0, 20)}.md`, a.answer || '', 'text/markdown;charset=utf-8')}
                                                className="text-[11px] text-zinc-400 hover:text-zinc-600"
                                            >下载</button>
                                            <span className="ml-auto text-[10px] text-zinc-300">{a.savedAt}</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </>
    );
}

export default AssetsDrawer;
