import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

// 解析核对弹层（二期"人工核对关"）：
// 解析结果质检可疑时先展示章节树 + 质检报告，可改名/删章/重切，确认后才正式入库。
// props:
//   bookId      — 当前核对的草稿 id
//   queuePos / queueTotal — 多本排队位置（上传一批可疑书时逐本核对）
//   onResolved  — 该书已处理完（入库/放弃），父组件推进队列或关闭
//   onBooksChanged — commit 成功后父组件刷新书架
const LEVEL_STYLE = {
    blocking: 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/30',
    warning: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/30',
    info: 'bg-zinc-50 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800',
};
const RULE_LABEL = {
    R1: '单章吞书', R2: '章数过少', R3: '疑似前置页', R4: '清洗后近空章',
    R5: '疑似仅章节页', R6: '目录层级压平', R7: '正文覆盖不足', R8: '锚点乱序',
    R9: '解析退化', R10: 'EPUB 锚点失配',
};

function QcChip({ item }) {
    return (
        <span
            title={item.msg}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] leading-4 flex-shrink-0 ${LEVEL_STYLE[item.level] || LEVEL_STYLE.info}`}
        >
            <span className="font-semibold tabular-nums">{item.rule}</span>
            {RULE_LABEL[item.rule] || ''}
        </span>
    );
}

function ChapterRow({ ch, removed, editedTitle, onToggleRemoved, onRename }) {
    const [open, setOpen] = useState(false);
    const worst = ch.marks.some(m => m.level === 'blocking') ? 'blocking'
        : ch.marks.some(m => m.level === 'warning') ? 'warning' : null;
    return (
        <div className={`border rounded-xl transition-colors ${removed ? 'border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 opacity-50' : worst === 'blocking' ? 'border-red-200 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/10' : worst === 'warning' ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/30 dark:bg-amber-500/10' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'}`}>
            <div className="flex items-center gap-2 px-3 py-2">
                <input
                    type="checkbox"
                    checked={removed}
                    onChange={e => onToggleRemoved(ch.chapter_id, e.target.checked)}
                    className="w-3.5 h-3.5 accent-red-600 flex-shrink-0"
                    title="勾选后入库时删除此章"
                />
                <input
                    value={editedTitle}
                    onChange={e => onRename(ch.chapter_id, e.target.value)}
                    disabled={removed}
                    className={`flex-1 min-w-0 bg-transparent text-sm outline-none border-b border-transparent focus:border-zinc-300 px-0.5 ${removed ? 'line-through text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200'}`}
                    title="点击可直接修改章名"
                    data-pr-title={ch.chapter_id}
                />
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums flex-shrink-0">
                    {(ch.cleaned_word_count ?? ch.word_count ?? 0).toLocaleString()} 字
                </span>
                {ch.marks.length > 0 && (
                    <span className="flex items-center gap-1 flex-shrink-0">
                        {ch.marks.map((m, i) => <QcChip key={i} item={m} />)}
                    </span>
                )}
                <button
                    onClick={() => setOpen(o => !o)}
                    className="text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 flex-shrink-0 w-8 text-right"
                >
                    {open ? '收起' : '预览'}
                </button>
            </div>
            {open && (
                <p className="px-3 py-2 mx-3 mb-2.5 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed whitespace-pre-wrap break-all border-t border-dashed border-zinc-200 dark:border-zinc-800 rounded-b-lg bg-zinc-50/60 dark:bg-zinc-900/60">
                    {ch.content_head || '（正文为空）'}…
                </p>
            )}
        </div>
    );
}

function ParseReviewModal({ bookId, queuePos, queueTotal, onResolved, onBooksChanged }) {
    const [detail, setDetail] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [titles, setTitles] = useState({});      // chapter_id → 编辑后的标题
    const [removed, setRemoved] = useState([]);    // chapter_id[]
    const [busy, setBusy] = useState(false);       // commit/discard/reseg 进行中
    const [notice, setNotice] = useState(null);    // 弹层内提示（代替 alert）

    const reload = useCallback(() => {
        setDetail(null);
        setLoadError(null);
        fetch(`${API_BASE}/books/reviews/${bookId}`)
            .then(async r => {
                if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || String(r.status));
                return r.json();
            })
            .then(d => {
                setDetail(d);
                setTitles({});
                setRemoved([]);
                setNotice(null);
            })
            .catch(e => setLoadError(e.message));
    }, [bookId]);

    useEffect(() => { reload(); }, [reload]);

    const titleOf = (ch) => titles[ch.chapter_id] ?? ch.title ?? '';
    const toggleRemoved = (cid, on) =>
        setRemoved(prev => on ? [...prev, cid] : prev.filter(x => x !== cid));

    const buildCommitBody = (force) => {
        const renames = {};
        for (const [cid, t] of Object.entries(titles)) {
            const orig = (detail.chapters.find(c => c.chapter_id === cid) || {}).title;
            if (t.trim() && t.trim() !== orig) renames[cid] = t.trim();
        }
        return { delete_chapter_ids: removed, renames, force: !!force };
    };

    const handleCommit = async (force) => {
        setBusy(true);
        setNotice(null);
        try {
            const res = await fetch(`${API_BASE}/books/reviews/${bookId}/commit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildCommitBody(force)),
            });
            if (res.ok) {
                onBooksChanged();
                onResolved();
                return;
            }
            const err = await res.json().catch(() => ({}));
            if (res.status === 409 && detail.blocking && !force) {
                // 阻断性问题：让用户二次确认后带 force 重发
                if (confirm(`质检发现阻断性问题：\n${err.detail || ''}\n\n确定仍要入库？（建议先「重新解析」或删掉问题章）`)) {
                    await handleCommit(true);
                    return;
                }
            } else {
                setNotice(`入库失败: ${err.detail || res.status}`);
            }
        } catch (e) {
            setNotice(`入库失败: ${e.message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDiscard = async () => {
        if (!confirm(`放弃《${detail.title || bookId}》？草稿与已上传的源文件都会删除。`)) return;
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/books/reviews/${bookId}/discard`, { method: 'POST' });
            if (!res.ok && res.status !== 404) {
                const err = await res.json().catch(() => ({}));
                setNotice(`放弃失败: ${err.detail || res.status}`);
                return;
            }
            onResolved();
        } catch (e) {
            setNotice(`放弃失败: ${e.message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleResegment = async () => {
        setBusy(true);
        setNotice(null);
        try {
            const res = await fetch(`${API_BASE}/books/reviews/${bookId}/resegment`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setNotice(`重新解析失败: ${data.detail || res.status}`);
                return;
            }
            if (data.status === 'committed') {
                // 重切后质检全绿 → 后端已自动入库，直接推进队列
                onBooksChanged();
                onResolved();
                return;
            }
            await reload();
            setNotice(data.resegmented
                ? '已用 AI 重切结果刷新章节树，请再次核对'
                : '重新解析完成，仍有可疑项，请核对后入库');
        } catch (e) {
            setNotice(`重新解析失败: ${e.message}`);
        } finally {
            setBusy(false);
        }
    };

    const qcItems = detail?.qc_report?.items || [];
    const blockingCount = qcItems.filter(i => i.level === 'blocking').length;

    return (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" data-testid="parse-review-modal">
            <div className="w-full max-w-3xl max-h-[88vh] bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl flex flex-col overflow-hidden">
                {/* 头 */}
                <div className="px-6 pt-5 pb-4 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-semibold tracking-widest uppercase text-amber-500">解析核对</span>
                        {queueTotal > 1 && (
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums" data-testid="pr-queue-pos">{queuePos} / {queueTotal}</span>
                        )}
                        {detail?.resegmented && (
                            <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/30 text-[10px]">AI 已重切</span>
                        )}
                        <span className="ml-auto text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums">
                            {detail ? `${detail.chapters.length} 章 · ${detail.chapters.reduce((s, c) => s + (c.cleaned_word_count ?? c.word_count ?? 0), 0).toLocaleString()} 字` : ''}
                        </span>
                    </div>
                    <h2 className="mt-1 text-lg font-serif-heading font-bold text-zinc-900 dark:text-zinc-100 truncate">
                        {detail?.title || bookId}
                    </h2>
                    {detail && blockingCount > 0 && (
                        <p className="mt-1 text-xs text-red-500 dark:text-red-400" data-testid="pr-blocking-hint">
                            {blockingCount} 项阻断性问题——直接入库会被拦截，建议先「重新解析」或删掉问题章
                        </p>
                    )}
                </div>

                {/* 体 */}
                <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4 space-y-4">
                    {loadError && (
                        <div className="text-center py-10">
                            <p className="text-sm text-zinc-500 dark:text-zinc-400">草稿读取失败: {loadError}</p>
                            <button onClick={reload} className="mt-3 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-600">重试</button>
                        </div>
                    )}
                    {!detail && !loadError && (
                        <div className="flex items-center justify-center py-16 gap-2 text-zinc-400 dark:text-zinc-500 text-sm">
                            <div className="animate-spin h-4 w-4 border-2 border-zinc-300 dark:border-zinc-700 border-t-transparent rounded-full"></div>
                            读取草稿…
                        </div>
                    )}
                    {detail && (<>
                        {qcItems.length > 0 && (
                            <div>
                                <p className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">质检报告</p>
                                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800 overflow-hidden">
                                    {qcItems.map((it, i) => (
                                        <div key={i} className="flex items-start gap-2 px-3 py-2 bg-white dark:bg-zinc-900">
                                            <QcChip item={it} />
                                            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed flex-1">{it.msg}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {detail.dropped.length > 0 && (
                            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                                入库时将自动丢弃 {detail.dropped.length} 个清洗后空章：
                                {detail.dropped.map(d => `《${d.title || d.chapter_id}》`).join('、')}
                            </p>
                        )}
                        <div>
                            <p className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">
                                章节树（改章名 / 勾选删除，确认后入库）
                            </p>
                            <div className="space-y-1.5">
                                {detail.chapters.map(ch => (
                                    <ChapterRow
                                        key={ch.chapter_id}
                                        ch={ch}
                                        removed={removed.includes(ch.chapter_id)}
                                        editedTitle={titleOf(ch)}
                                        onToggleRemoved={toggleRemoved}
                                        onRename={(cid, t) => setTitles(prev => ({ ...prev, [cid]: t }))}
                                    />
                                ))}
                            </div>
                        </div>
                    </>)}
                    {notice && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg px-3 py-2" data-testid="pr-notice">{notice}</p>
                    )}
                </div>

                {/* 底 */}
                <div className="px-6 py-4 border-t border-zinc-100 dark:border-zinc-800 flex items-center gap-2 flex-shrink-0">
                    <button
                        onClick={handleDiscard}
                        disabled={busy || !detail}
                        className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 hover:border-red-300 dark:hover:border-red-400/70 hover:text-red-500 dark:hover:text-red-400 disabled:opacity-40 transition-all"
                        data-testid="pr-discard"
                    >
                        放弃此书
                    </button>
                    <button
                        onClick={handleResegment}
                        disabled={busy || !detail}
                        className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-600 disabled:opacity-40 transition-all"
                        data-testid="pr-reseg"
                        title="用已上传的原文件整体重跑解析（可疑时自动 AI 重切）"
                    >
                        {busy ? '处理中…' : '重新解析'}
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                        {queueTotal > 1 && (
                            <button
                                onClick={onResolved}
                                disabled={busy}
                                className="px-3 py-2 rounded-xl text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40"
                                title="暂不处理，核对完队列后从书架徽标再进入"
                            >
                                稍后再说
                            </button>
                        )}
                        <button
                            onClick={() => handleCommit(false)}
                            disabled={busy || !detail}
                            className="px-4 py-2 rounded-xl bg-zinc-800 dark:bg-zinc-700 text-white text-xs font-medium hover:bg-zinc-900 dark:hover:bg-zinc-600 disabled:opacity-40 transition-all"
                            data-testid="pr-commit"
                        >
                            确认入库（{detail ? detail.chapters.length - removed.length : 0} 章）
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ParseReviewModal;
