import { useMemo, useState } from 'react';

// v3.7 批注抽屉：全书高亮+笔记按章结集（顶栏「批注」唤出，右侧满高，与资产区同款镜像）
// 点条跳原文（复用引用跳章的 cite-flash）；色/笔记双筛；一键导出 Markdown 落 Obsidian「读点书吧」
const COLORS = [
    { key: 'amber', dot: 'bg-amber-400', text: 'text-amber-500', name: '重要' },
    { key: 'green', dot: 'bg-green-400', text: 'text-green-500', name: '喜欢' },
    { key: 'blue', dot: 'bg-blue-400', text: 'text-blue-500', name: '存疑' },
    { key: 'pink', dot: 'bg-pink-400', text: 'text-pink-500', name: '不认同' },
];
const colorOf = h => (COLORS.some(c => c.key === h.color) ? h.color : 'amber');

function downloadText(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

function AnnotationsDrawer({ book, highlights, onClose, onJump, onRemove, onQuoteToChat }) {
    const [colorF, setColorF] = useState(null);     // null=全部
    const [onlyNoted, setOnlyNoted] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState(null);  // {ok, text, content?, filename?}

    const all = highlights || [];
    const notedTotal = useMemo(() => all.filter(h => (h.note || '').trim()).length, [all]);
    const countOf = c => all.filter(h => colorOf(h) === c).length;

    // 按书的章节顺序分组；章已漂移（重切书）的划线归「散页」
    const groups = useMemo(() => {
        const known = new Set();
        const out = [];
        for (const c of (book?.chapters || [])) {
            known.add(c.chapter_id);
            const items = all.filter(h => h.chapter_id === c.chapter_id);
            if (items.length) out.push({ key: c.chapter_id, title: c.title || '未命名章', items });
        }
        const orphan = all.filter(h => !known.has(h.chapter_id));
        if (orphan.length) out.push({ key: '__orphan', title: '散页（原章节已重切）', items: orphan });
        return out;
    }, [all, book?.chapters]);

    const visible = groups
        .map(g => ({
            ...g,
            items: g.items.filter(h => (!colorF || colorOf(h) === colorF) && (!onlyNoted || (h.note || '').trim())),
        }))
        .filter(g => g.items.length);

    const chip = (id, label, dotCls) => (
        <button
            key={id ?? 'all'}
            onClick={() => setColorF(id)}
            data-ann-filter={id ?? 'all'}
            className={`flex items-center gap-1 px-2 py-1 rounded-[10px] text-[11px] font-medium transition-all ${colorF === id ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'}`}
        >
            {dotCls && <span className={`w-2 h-2 rounded-full ${dotCls}`} />}
            {label}
        </button>
    );

    const doExport = async () => {
        if (exporting) return;
        setExporting(true);
        setExportMsg(null);
        try {
            const res = await fetch('/highlights/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ book_id: book.book_id }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.detail || `请求失败 ${res.status}`);
            if (d.ok) {
                setExportMsg({ ok: true, text: `已写入 ${d.path}` });
            } else {
                // 写盘失败（权限/路径）：内容照给，浏览器下载兜底
                setExportMsg({ ok: false, text: `写盘失败：${d.write_error || '未知原因'}，已改为下载`, content: d.content, filename: `${book.title}.md` });
                if (d.content) downloadText(`${book.title}.md`, d.content);
            }
        } catch (e) {
            setExportMsg({ ok: false, text: String(e.message || e) });
        } finally {
            setExporting(false);
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className="fixed right-0 top-0 bottom-0 z-50 w-96 bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col" style={{ animation: 'fade-in 0.2s ease-out' }}>
                {/* 标题栏：计数 + 导出 + 关闭 */}
                <div className="px-4 pt-4 pb-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2 flex-shrink-0">
                    <h3 className="text-sm font-serif-heading font-semibold text-zinc-800 dark:text-zinc-200">批注</h3>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums" data-ann-count>({all.length})</span>
                    {notedTotal > 0 && (
                        <span className="text-[11px] text-emerald-500 tabular-nums">· {notedTotal} 条笔记</span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        <button
                            onClick={doExport}
                            disabled={exporting || all.length === 0}
                            title="全书高亮+笔记导出 Markdown，写入 Obsidian「读点书吧」"
                            data-ann-export
                            className="px-2.5 py-1 rounded-lg bg-zinc-800 dark:bg-zinc-700 text-white text-[11px] font-medium hover:bg-zinc-900 dark:hover:bg-zinc-600 disabled:opacity-40 transition-all"
                        >{exporting ? '导出中…' : '导出 MD'}</button>
                        <button onClick={onClose} title="关闭" className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* 导出结果条 */}
                {exportMsg && (
                    <div data-ann-export-msg className={`px-4 py-1.5 text-[11px] border-b flex items-center gap-2 ${exportMsg.ok ? 'text-emerald-600 dark:text-emerald-400 border-zinc-100 dark:border-zinc-800' : 'text-red-500 border-zinc-100 dark:border-zinc-800'}`}>
                        <span className="truncate" title={exportMsg.text}>{exportMsg.text}</span>
                        {exportMsg.content && (
                            <button onClick={() => downloadText(exportMsg.filename, exportMsg.content)} className="ml-auto flex-shrink-0 underline hover:opacity-70">再下载</button>
                        )}
                    </div>
                )}

                {/* 筛选：颜色 + 只看有笔记 */}
                <div className="px-4 pt-3 flex items-center gap-0.5 flex-shrink-0 flex-wrap">
                    {chip(null, '全部')}
                    {COLORS.map(c => chip(c.key, String(countOf(c.key)), c.dot))}
                    <button
                        onClick={() => setOnlyNoted(v => !v)}
                        data-ann-filter-noted={onlyNoted ? 'on' : 'off'}
                        className={`ml-auto px-2 py-1 rounded-[10px] text-[11px] font-medium transition-all ${onlyNoted ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'}`}
                    >✎ 只看有笔记</button>
                </div>

                {/* 按章分组列表 */}
                <div className="flex-1 overflow-y-auto scrollbar-thin p-4 pt-2 space-y-4">
                    {all.length === 0 && (
                        <p className="text-xs text-zinc-300 text-center py-10">还没有高亮——读书时选中一段文字，点色板试试</p>
                    )}
                    {all.length > 0 && visible.length === 0 && (
                        <p className="text-xs text-zinc-300 text-center py-10">这个筛选下没有条目</p>
                    )}
                    {visible.map(g => (
                        <section key={g.key} data-ann-group={g.title}>
                            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 mb-1.5">
                                <span className="truncate">{g.title}</span>
                                <span className="tabular-nums flex-shrink-0">{g.items.length}</span>
                            </h4>
                            <div className="space-y-1.5">
                                {g.items.map(h => {
                                    const c = COLORS.find(x => x.key === colorOf(h));
                                    const noted = (h.note || '').trim();
                                    return (
                                        <div
                                            key={h.highlight_id}
                                            data-ann-item={h.highlight_id}
                                            onClick={() => { onJump?.(book.book_id, h.chapter_id, (h.text || '').slice(0, 60)); onClose(); }}
                                            className="group flex items-start gap-2 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 px-3 py-2 cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-600 transition-all"
                                        >
                                            <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${c.dot}`} title={c.name} />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs text-zinc-700 dark:text-zinc-200 leading-5 line-clamp-2">{h.text}</p>
                                                {noted && <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 leading-4 line-clamp-2">✎ {noted}</p>}
                                            </div>
                                            <span className="text-[10px] text-zinc-300 flex-shrink-0 tabular-nums mt-0.5">{(h.created_at || '').slice(5, 10)}</span>
                                            <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); onQuoteToChat?.({ text: h.text, chapter_id: h.chapter_id, chapter_title: h.chapter_title }); onClose(); }}
                                                    title="加入对话" data-ann-quote={h.highlight_id}
                                                    className="p-1 rounded text-zinc-300 hover:text-sky-500 transition-colors"
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                                                    </svg>
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); onRemove?.(h.highlight_id); }}
                                                    title="删除这条高亮" data-ann-remove={h.highlight_id}
                                                    className="p-1 rounded text-zinc-300 hover:text-red-500 transition-colors"
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </div>
            </div>
        </>
    );
}

export default AnnotationsDrawer;
