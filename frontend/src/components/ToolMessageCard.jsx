import { useState, useEffect, useRef } from 'react';
// markmap：迁移 Vite 后直接 import 打包（不依赖 CDN 全局变量）
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

// ---------- 文本渲染（自旧 AI 工具面板迁移，块化排版工具产出） ----------
function processText(text) {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, j) => {
        const m = part.match(/^\*\*([^*]+)\*\*$/);
        return m
            ? <strong key={j} className="font-semibold">{m[1]}</strong>
            : part.replace(/[*#]/g, '');
    });
}

function renderLine(line, idx, opts = {}) {
    const { isTitle, isBody } = opts;
    const t = line.trim();
    if (!t) return null;
    const afterH = t.replace(/^#{1,3}\s+/, '');

    if (isTitle) {
        const tm = afterH.match(/^(\d+[\.\、]|[一二三四五六七八九十]+[、\.])\s*(.*)/);
        return <p key={idx} className="text-base font-bold text-zinc-900 leading-snug">
            {tm ? [tm[1] + ' ', ...processText(tm[2])] : processText(afterH)}
        </p>;
    }

    const sbm = t.match(/^(\s{2,})[-*]\s+(.*)/);
    if (sbm) return <p key={idx} className="text-sm text-zinc-600 leading-relaxed pl-7 mt-1.5">{'◦ '}{processText(sbm[2])}</p>;

    const bm = t.match(/^[-*]\s+(.*)/);
    if (bm) return <p key={idx} className="text-sm text-zinc-700 leading-relaxed pl-5 mt-1.5">{'· '}{processText(bm[1])}</p>;

    const nm = t.match(/^(\d+[\.\、])\s*(.*)/);
    if (nm) return <p key={idx} className="text-sm text-zinc-700 leading-relaxed pl-5 mt-1.5">{nm[1] + ' '}{processText(nm[2])}</p>;

    if (isBody) return <p key={idx} className="text-sm text-zinc-700 leading-relaxed mt-1.5" style={{ textIndent: '2em' }}>{processText(afterH)}</p>;

    return <p key={idx} className="text-sm text-zinc-700 leading-relaxed mt-1.5">{processText(afterH)}</p>;
}

function convertTables(text) {
    const lines = text.split('\n');
    const out = [];
    let inTable = false, headers = [];
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^\|.+\|$/.test(t)) {
            const cells = t.split('|').filter(c => c.trim()).map(c => c.trim());
            if (cells.every(c => /^[-]{2,}$/.test(c.replace(/\s/g, '')))) {
                inTable = true; continue;
            }
            if (!inTable) { headers = cells; inTable = true; continue; }
            headers.forEach((h, idx) => {
                if (idx < cells.length) out.push(`- ${h}：${cells[idx]}`);
            });
            out.push('');
        } else {
            inTable = false; headers = []; out.push(lines[i]);
        }
    }
    return out.join('\n');
}

function renderToolBlocks(raw) {
    const cleaned = convertTables(raw);
    const blocks = cleaned.split(/(?=^\s*\d+[\.\、]|^[一二三四五六七八九十]+[、\.]|^#{1,3}\s+)/m).filter(b => b.trim());

    const renderBlock = (block, i) => {
        const lines = block.split('\n').filter(l => l.trim());
        const firstLine = lines[0] || '';
        if (lines.length === 1 && firstLine.length > 50) {
            const idx = firstLine.search(/[：。？]/);
            if (idx > 10 && idx < firstLine.length - 5) {
                const titleText = firstLine.substring(0, idx + 1);
                const bodyText = firstLine.substring(idx + 1).trim();
                const bodyLines = bodyText.split('\n').filter(l => l.trim());
                return (
                    <div key={i} className="bg-zinc-50/60 border border-zinc-100 rounded-xl overflow-hidden">
                        <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{renderLine(titleText, 0, { isTitle: true })}</div>
                        <div className="px-4 pt-3 pb-4">{bodyLines.map((line, j) => renderLine(line, j + 1, { isBody: true }))}</div>
                    </div>
                );
            }
        }
        const title = renderLine(firstLine, 0, { isTitle: true });
        if (lines.length === 1) {
            return <div key={i} className="bg-zinc-50/60 border border-zinc-100 rounded-xl overflow-hidden"><div className="px-4 pt-4 pb-2">{title}</div></div>;
        }
        const body = lines.slice(1).map((line, j) => renderLine(line, j + 1, { isBody: true }));
        return (
            <div key={i} className="bg-zinc-50/60 border border-zinc-100 rounded-xl overflow-hidden">
                <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{title}</div>
                <div className="px-4 pt-3 pb-4">{body}</div>
            </div>
        );
    };

    if (blocks.length <= 1) {
        const paragraphs = cleaned.split(/\n\n+/).filter(b => b.trim());
        return paragraphs.map((para, i) => {
            const lines = para.split('\n').filter(l => l.trim());
            const firstLine = lines[0] || '';
            if (lines.length === 1 && firstLine.length > 50) {
                const idx = firstLine.search(/[：。？]/);
                if (idx > 10 && idx < firstLine.length - 5) {
                    const titleText = firstLine.substring(0, idx + 1);
                    const bodyText = firstLine.substring(idx + 1).trim();
                    const bodyLines = bodyText.split('\n').filter(l => l.trim());
                    return (
                        <div key={i} className="bg-zinc-50/60 border border-zinc-100 rounded-xl overflow-hidden">
                            <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{renderLine(titleText, 0, { isTitle: true })}</div>
                            <div className="px-4 pt-3 pb-4">{bodyLines.map((line, j) => renderLine(line, j + 1, { isBody: true }))}</div>
                        </div>
                    );
                }
            }
            const titleEl = renderLine(firstLine, 0, { isTitle: true });
            if (lines.length === 1) {
                return <div key={i} className="bg-zinc-50/60 border border-zinc-100 rounded-xl overflow-hidden"><div className="px-4 pt-4 pb-2">{titleEl}</div></div>;
            }
            const body = lines.slice(1).map((line, j) => renderLine(line, j + 1, { isBody: true }));
            return (
                <div key={i} className="bg-zinc-50/60 border border-zinc-100 rounded-xl overflow-hidden">
                    <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{titleEl}</div>
                    <div className="px-4 pt-3 pb-4">{body}</div>
                </div>
            );
        });
    }
    return blocks.map(renderBlock);
}

const cleanMindmapData = (raw) => {
    const idx = raw.indexOf('\n# ');
    return idx >= 0 ? raw.slice(idx + 1).trim() : raw.trim();
};

function MindmapSvg({ data, height = 420, onExpand }) {
    const ref = useRef(null);
    useEffect(() => {
        if (!ref.current) return;
        const timer = setTimeout(() => {
            if (!ref.current) return;
            try {
                const t = new Transformer();
                const { root } = t.transform(cleanMindmapData(data));
                ref.current.innerHTML = '';
                Markmap.create(ref.current, {
                    maxWidth: 300,
                    color: n => ['#18181b', '#3f3f46', '#52525b', '#71717a', '#a1a1aa'][Math.min(n.d || 0, 4)]
                }, root);
            } catch (e) {
                console.error('markmap 渲染失败:', e);
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [data]);
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-zinc-400">可缩放、折叠</span>
                <button onClick={onExpand} className="text-xs font-medium text-zinc-500 hover:text-zinc-700 bg-zinc-100 hover:bg-zinc-200 px-3 py-1 rounded-full transition-all">
                    放大
                </button>
            </div>
            <svg ref={ref} className="w-full bg-white rounded-xl border border-zinc-100" style={{ height }}></svg>
        </div>
    );
}

function MindmapOverlay({ data, onClose }) {
    const ref = useRef(null);
    useEffect(() => {
        const timer = setTimeout(() => {
            if (!ref.current) return;
            try {
                const t = new Transformer();
                const { root } = t.transform(cleanMindmapData(data));
                ref.current.innerHTML = '';
                Markmap.create(ref.current, {
                    maxWidth: 400,
                    color: n => ['#18181b', '#3f3f46', '#52525b', '#71717a', '#a1a1aa'][Math.min(n.d || 0, 4)]
                }, root);
            } catch (e) { console.error('overlay markmap 渲染失败:', e); }
        }, 100);
        return () => clearTimeout(timer);
    }, [data]);
    return (
        <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', animation: 'fade-in 0.2s ease-out' }}>
            <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-3xl shadow-2xl border border-zinc-200 flex flex-col overflow-hidden" style={{ width: '92vw', height: '90vh' }}>
                <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
                    <h2 className="text-base font-serif-heading font-semibold text-zinc-800 truncate">
                        {cleanMindmapData(data || '').split('\n')[0]?.replace(/^#\s*/, '') || '思维导图'}
                    </h2>
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-all">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="flex-1 overflow-auto p-4">
                    <svg ref={ref} className="w-full h-full"></svg>
                </div>
            </div>
        </div>
    );
}

// ---------- 工具产出消息卡（v2.0：产出即消息，流进对话流） ----------
function ToolMessageCard({ msg, favorites, onToggleFavorite, onNavigateToSource }) {
    const [mindmapExpanded, setMindmapExpanded] = useState(false);
    const [htmlExpanded, setHtmlExpanded] = useState(false);
    const streaming = !!msg.streaming;
    const content = msg.content || '';

    const canFavorite = !streaming && !msg.error && msg.output_type !== 'html' && msg.tool_id !== 'mindmap' && content.trim();
    const alreadyFav = favorites?.some(f => f.type === 'tool' && f.toolId === msg.tool_id && f.answer === content);

    return (
        <div className="message-enter">
            <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden">
                {/* 卡片头：工具名 + 范围 + 收藏 */}
                <div className="px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/60 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span className="text-xs font-semibold text-zinc-700">{msg.tool_name || msg.tool_id}</span>
                    {msg.scope && <span className="text-[11px] text-zinc-400 truncate">· {msg.scope}</span>}
                    {streaming && (
                        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-400 flex-shrink-0">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 animate-pulse"></span>
                            {msg.status || '生成中'}
                        </span>
                    )}
                    {canFavorite && (
                        <button
                            onClick={() => onToggleFavorite({ type: 'tool', toolId: msg.tool_id, toolLabel: msg.tool_name, question: msg.scope || '整本书', answer: content })}
                            className={`ml-auto p-1 rounded-lg transition-all flex-shrink-0 ${alreadyFav ? 'text-zinc-500 bg-zinc-100' : 'text-zinc-300 hover:text-zinc-500 hover:bg-zinc-100'}`}
                            title={alreadyFav ? '取消收藏' : '收藏结果'}
                        >
                            <svg className="w-3.5 h-3.5" fill={alreadyFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                            </svg>
                        </button>
                    )}
                </div>

                {/* 卡片体 */}
                <div className="px-4 py-3">
                    {msg.error ? (
                        <div className="flex items-start gap-2 text-zinc-500">
                            <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="text-xs">{msg.error}</p>
                        </div>
                    ) : msg.output_type === 'html' ? (
                        <div className="space-y-3">
                            <p className="text-sm text-zinc-600 leading-relaxed">已生成精读笔记 HTML 页（章节摘要、关键词、原文摘录与 AI 批注）。</p>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setHtmlExpanded(true)}
                                    className="flex-1 py-2 bg-zinc-800 text-white rounded-full text-sm font-medium hover:bg-zinc-900 transition-all"
                                >
                                    查看
                                </button>
                                <button
                                    onClick={() => {
                                        const blob = new Blob(['\ufeff' + content], { type: 'text/html;charset=utf-8' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url; a.download = msg.filename || '精读笔记.html'; a.click();
                                        URL.revokeObjectURL(url);
                                    }}
                                    className="flex-1 py-2 bg-white border border-zinc-200 text-zinc-600 rounded-full text-sm font-medium hover:bg-zinc-50 transition-all"
                                >
                                    下载
                                </button>
                            </div>
                        </div>
                    ) : msg.tool_id === 'mindmap' && !streaming && content.trim() ? (
                        <MindmapSvg data={content} onExpand={() => setMindmapExpanded(true)} />
                    ) : (
                        <div className="space-y-3">
                            {content.trim()
                                ? renderToolBlocks(content)
                                : <p className="text-xs text-zinc-400">生成中…</p>}
                            {!streaming && msg.sources?.length > 0 && (
                                <div className="pt-2 border-t border-zinc-100 flex flex-wrap gap-1.5 items-center">
                                    <span className="text-[11px] text-zinc-400">引用：</span>
                                    {(msg.book_id ? msg.sources : msg.sources).map((s, i) => (
                                        <button key={i} onClick={() => onNavigateToSource?.(s.book_id, s.chapter_id)} className="text-[11px] px-2 py-0.5 bg-zinc-50 text-zinc-500 rounded-full border border-zinc-100 hover:bg-zinc-100 transition-colors">
                                            {s.chapter_title}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {mindmapExpanded && <MindmapOverlay data={content} onClose={() => setMindmapExpanded(false)} />}
            {htmlExpanded && (
                <div onClick={() => setHtmlExpanded(false)} className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', animation: 'fade-in 0.2s ease-out' }}>
                    <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-3xl shadow-2xl border border-zinc-200 flex flex-col overflow-hidden" style={{ width: '92vw', height: '90vh' }}>
                        <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
                            <h2 className="text-base font-serif-heading font-semibold text-zinc-800 truncate">精读笔记</h2>
                            <button onClick={() => setHtmlExpanded(false)} className="p-2 rounded-full hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-all">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <div className="flex-1 min-h-0">
                            <iframe srcDoc={content} title="精读笔记" className="w-full h-full border-0"></iframe>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ToolMessageCard;
