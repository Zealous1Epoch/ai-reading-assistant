import { useState, useRef, useEffect } from 'react';
// markmap 原通过 CDN 挂到 window.markmap，迁移 Vite 后改为直接 import 打包
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

function RightPanel({ currentBook, currentChapter, toolState, onRunTool, onBackToTools, favorites, onToggleFavorite, onRemoveFavorite }) {
    const [selectedFavs, setSelectedFavs] = useState([]);
    const [toolView, setToolView] = useState('cards');
    const [toolInput, setToolInput] = useState('');
    const [pendingToolId, setPendingToolId] = useState(null);
    const [mindmapExpanded, setMindmapExpanded] = useState(false);

    // 仅「与作者对谈」需要输入问题；其余工具的作用范围 = 左栏当前选中
    const needsInput = { 'author-talk': true };

    const tools = [
        { id: 'summarize', label: '总结', desc: '总结整本书或当前选中章节', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
        { id: 'background', label: '背景调研', desc: '探索书籍的时代与学术背景', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
        { id: 'questions', label: '读书十问', desc: '十个深度问题帮你吃透一本书', icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
        { id: 'mindmap', label: '思维导图', desc: '按当前范围生成知识框架与逻辑脉络', icon: 'M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4' },
        { id: 'recommend', label: '书籍推荐', desc: '推荐同主题的好书', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
        { id: 'author-talk', label: '与作者对谈', desc: '基于书中论点向作者提问', icon: 'M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
        { id: 'knowledge-graph', label: '精读笔记', desc: '生成可下载的精读笔记页', icon: 'M4 6h16M4 12h16M4 18h16M8 2v4m8-4v4M8 16v4m8-4v4' },
    ];

    const toggleFavSelect = (id) => {
        setSelectedFavs(prev =>
            prev.includes(id) ? prev.filter(fid => fid !== id) : [...prev, id]
        );
    };

    const exportFavorites = () => {
        const toExport = favorites.filter(f => selectedFavs.includes(f.id));
        if (toExport.length === 0) { alert('请先勾选要导出的收藏'); return; }
        const content = toExport.map(f => {
            const header = f.type === 'tool' ? `=== AI工具 · ${f.toolLabel || '未知'} ===` : '=== 收藏问答 ===';
            return `${header}\n保存时间: ${f.savedAt || '未知'}\n\n问: ${f.question}\n\n答: ${f.answer}\n\n---\n`;
        }).join('\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `收藏问答_${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleToolCardClick = (toolId) => {
        if (!currentBook) return;
        if (needsInput[toolId]) {
            setPendingToolId(toolId);
            setToolView('input');
            setToolInput('');
        } else {
            onRunTool(toolId, null);
        }
    };

    const handleInputSubmit = () => {
        if (!toolInput.trim()) return;
        onRunTool(pendingToolId, toolInput.trim());
        setToolView('cards');
    };

    const handleInputKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleInputSubmit();
        }
    };

    useEffect(() => {
        if (toolState?.result && (!toolState?.loading || toolState.result.streaming)) {
            setToolView('result');
        }
    }, [toolState?.result, toolState?.loading]);

    const toolLabel = {
        summarize: '总结', background: '背景调研', questions: '读书十问',
        mindmap: '思维导图', recommend: '书籍推荐', 'author-talk': '与作者对谈',
        'knowledge-graph': '精读笔记'
    };

    const inputPlaceholder = {
        'author-talk': '你想问作者的问题'
    };

    const mindmapRef = useRef(null);
    const overlayMindmapRef = useRef(null);

    const cleanMindmapData = (raw) => {
        const idx = raw.indexOf('\n# ');
        return idx >= 0 ? raw.slice(idx + 1).trim() : raw.trim();
    };

    useEffect(() => {
        if (toolState?.toolId === 'mindmap' && toolState?.result?.data && !toolState?.loading) {
            const timer = setTimeout(() => {
                if (mindmapRef.current) {
                    try {
                        const t = new Transformer();
                        const { root } = t.transform(cleanMindmapData(toolState.result.data));
                        mindmapRef.current.innerHTML = '';
                        Markmap.create(mindmapRef.current, { maxWidth: 300, color: function(n) { return ['#18181b', '#3f3f46', '#52525b', '#71717a', '#a1a1aa'][Math.min(n.d || 0, 4)]; } }, root);
                    } catch (e) {
                        console.error('markmap 渲染失败:', e);
                        mindmapRef.current.innerHTML = '<text x="10" y="20" fill="red">渲染失败: ' + e.message + '</text>';
                    }
                }
            }, 200);
            return () => clearTimeout(timer);
        }
    }, [toolState?.result, toolState?.loading, toolState?.toolId]);

    useEffect(() => {
        if (mindmapExpanded && overlayMindmapRef.current && toolState?.result?.data) {
            const timer = setTimeout(() => {
                try {
                    const t = new Transformer();
                    const { root } = t.transform(cleanMindmapData(toolState.result.data));
                    overlayMindmapRef.current.innerHTML = '';
                    Markmap.create(overlayMindmapRef.current, { maxWidth: 400, color: function(n) { return ['#18181b', '#3f3f46', '#52525b', '#71717a', '#a1a1aa'][Math.min(n.d || 0, 4)]; } }, root);
                } catch (e) {
                    console.error('overlay markmap 渲染失败:', e);
                }
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [mindmapExpanded, toolState?.result?.data]);

    const activeToolId = toolState?.toolId || pendingToolId;

    const handleBackToCards = () => {
        onBackToTools();
        setToolView('cards');
        setPendingToolId(null);
    };

    // tool result rendering helpers
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

    function renderResultBlocks(raw) {
        const cleaned = convertTables(raw);
        const blocks = cleaned.split(/(?=^\s*\d+[\.\、]|^[一二三四五六七八九十]+[、\.]|^#{1,3}\s+)/m).filter(b => b.trim());

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
                            <div key={i} className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden">
                                <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{renderLine(titleText, 0, { isTitle: true })}</div>
                                <div className="px-4 pt-3 pb-4">{bodyLines.map((line, j) => renderLine(line, j + 1, { isBody: true }))}</div>
                            </div>
                        );
                    }
                }
                const titleEl = renderLine(firstLine, 0, { isTitle: true });
                if (lines.length === 1) {
                    return <div key={i} className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden"><div className="px-4 pt-4 pb-2">{titleEl}</div></div>;
                }
                const body = lines.slice(1).map((line, j) => renderLine(line, j + 1, { isBody: true }));
                return (
                    <div key={i} className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden">
                        <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{titleEl}</div>
                        <div className="px-4 pt-3 pb-4">{body}</div>
                    </div>
                );
            });
        }

        return blocks.map((block, i) => {
            const lines = block.split('\n').filter(l => l.trim());
            const firstLine = lines[0] || '';
            if (lines.length === 1 && firstLine.length > 50) {
                const idx = firstLine.search(/[：。？]/);
                if (idx > 10 && idx < firstLine.length - 5) {
                    const titleText = firstLine.substring(0, idx + 1);
                    const bodyText = firstLine.substring(idx + 1).trim();
                    const bodyLines = bodyText.split('\n').filter(l => l.trim());
                    return (
                        <div key={i} className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden">
                            <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{renderLine(titleText, 0, { isTitle: true })}</div>
                            <div className="px-4 pt-3 pb-4">{bodyLines.map((line, j) => renderLine(line, j + 1, { isBody: true }))}</div>
                        </div>
                    );
                }
            }
            const title = renderLine(firstLine, 0, { isTitle: true });
            if (lines.length === 1) {
                return <div key={i} className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden"><div className="px-4 pt-4 pb-2">{title}</div></div>;
            }
            const body = lines.slice(1).map((line, j) => renderLine(line, j + 1, { isBody: true }));
            return (
                <div key={i} className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden">
                    <div className="px-4 pt-4 pb-2 border-b border-zinc-50">{title}</div>
                    <div className="px-4 pt-3 pb-4">{body}</div>
                </div>
            );
        });
    }

    return (
        <>
            <div className="w-80 bg-white rounded-3xl border border-zinc-200 flex flex-col h-full flex-shrink-0 overflow-hidden">
                {/* 头部 */}
                <div className="px-5 pt-5 pb-3 border-b border-zinc-100 flex items-center justify-between">
                    {activeToolId ? (
                        <>
                            <button onClick={handleBackToCards} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-700 transition-colors">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                </svg>
                                返回
                            </button>
                            <span className="text-sm font-medium text-zinc-700">{toolLabel[activeToolId] || activeToolId}</span>
                            {toolState?.result && !toolState?.loading && !toolState.result.error && activeToolId !== 'mindmap' && activeToolId !== 'knowledge-graph' && (
                                (() => {
                                    const label = toolLabel[activeToolId] || activeToolId;
                                    const scope = (toolInput || '').trim() || (currentChapter ? currentChapter.title : '整本书');
                                    const content = typeof toolState.result.data === 'string' ? toolState.result.data : '';
                                    const alreadyFav = favorites?.some(f => f.type === 'tool' && f.toolId === activeToolId && f.answer === content);
                                    return (
                                        <button
                                            onClick={() => onToggleFavorite({ type: 'tool', toolId: activeToolId, toolLabel: label, question: scope, answer: content })}
                                            className={`p-1.5 rounded-lg transition-all flex-shrink-0 ${alreadyFav ? 'text-zinc-500 bg-zinc-50' : 'text-zinc-300 hover:text-zinc-500 hover:bg-zinc-50'}`}
                                            title={alreadyFav ? '取消收藏' : '收藏结果'}
                                        >
                                            <svg className="w-4 h-4" fill={alreadyFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                                            </svg>
                                        </button>
                                    );
                                })()
                            )}
                        </>
                    ) : (
                        <div className="min-w-0">
                            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">AI 工具</h2>
                            <p className="text-[11px] text-zinc-400 mt-1 truncate">范围：{currentChapter ? currentChapter.title : '整本书'}</p>
                        </div>
                    )}
                </div>

                {/* 内容区域 */}
                <div className="overflow-y-auto scrollbar-thin p-4 space-y-3">
                    {/* 工具输入视图 */}
                    {activeToolId && toolView === 'input' && !toolState?.loading && !toolState?.result && (
                        <div className="animate-fade-in">
                            <p className="text-xs text-zinc-400 mb-3">{inputPlaceholder[activeToolId] || '请输入你的需求'}</p>
                            <div className="flex gap-2">
                                <input
                                    type="text" value={toolInput}
                                    onChange={(e) => setToolInput(e.target.value)}
                                    onKeyDown={handleInputKeyDown}
                                    placeholder={inputPlaceholder[activeToolId] || '请输入...'}
                                    className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-400"
                                    autoFocus
                                />
                                <button onClick={handleInputSubmit} disabled={!toolInput.trim()} className="px-4 py-2 bg-zinc-800 text-white rounded-full text-sm font-medium hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                                    确定
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 工具加载视图（流式已开始输出时不再显示转圈） */}
                    {activeToolId && toolState?.loading && !toolState?.result?.streaming && (
                        <div className="flex flex-col items-center justify-center py-10 animate-fade-in">
                            <div className="animate-spin h-8 w-8 border-2 border-zinc-300 border-t-transparent rounded-full mb-3"></div>
                            <p className="text-xs text-zinc-400">AI 处理中...</p>
                            <p className="text-xs text-zinc-300 mt-1">{toolLabel[activeToolId]}</p>
                        </div>
                    )}

                    {/* 工具结果视图（流式期间同步渲染已生成部分） */}
                    {activeToolId && toolState?.result && (!toolState?.loading || toolState?.result.streaming) && (
                        <div className="animate-fade-in">
                            {toolState.result.streaming && (
                                <div className="flex items-center gap-2 text-xs text-zinc-400 mb-3">
                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 animate-pulse"></span>
                                    {toolState.result.status || '生成中'}
                                </div>
                            )}
                            {toolState.result.error ? (
                                <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        <span className="font-medium text-xs">请求失败</span>
                                    </div>
                                    <p className="text-xs text-zinc-500">{toolState.result.error}</p>
                                </div>
                            ) : toolState.result.type === 'html' ? (
                                <div className="bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden">
                                    <div className="px-4 pt-4 pb-2 border-b border-zinc-50">
                                        <p className="text-base font-bold text-zinc-900">精读笔记已生成</p>
                                    </div>
                                    <div className="px-4 pt-3 pb-4 space-y-3">
                                        <p className="text-sm text-zinc-500">已为你生成精读笔记 HTML 页面，包含章节摘要、关键词、原文摘录与AI批注。可直接保存或打印。</p>
                                        <button
                                            onClick={() => {
                                                const html = toolState.result.data;
                                                const filename = toolState.result.filename || '精读笔记.html';
                                                const blob = new Blob(['﻿' + html], { type: 'text/html;charset=utf-8' });
                                                const url = URL.createObjectURL(blob);
                                                const a = document.createElement('a');
                                                a.href = url; a.download = filename; a.click();
                                                URL.revokeObjectURL(url);
                                            }}
                                            className="w-full py-2.5 bg-zinc-800 text-white rounded-full text-sm font-medium hover:bg-zinc-900 transition-all"
                                        >
                                            下载 HTML 文件
                                        </button>
                                        <details className="mt-2">
                                            <summary className="text-xs text-zinc-400 cursor-pointer hover:text-zinc-600">预览 HTML</summary>
                                            <div className="mt-2 border border-zinc-100 rounded-lg overflow-hidden" style={{ height: '400px' }}>
                                                <iframe srcDoc={toolState.result.data} className="w-full h-full border-0"></iframe>
                                            </div>
                                        </details>
                                    </div>
                                </div>
                            ) : activeToolId === 'mindmap' && toolState.result.streaming ? (
                                <pre className="text-xs text-zinc-500 whitespace-pre-wrap leading-relaxed">{toolState.result.data}</pre>
                            ) : activeToolId === 'mindmap' ? (
                                <div>
                                    <div className="flex items-center justify-between mb-3">
                                        <span className="text-xs text-zinc-400">可缩放、折叠的交互式思维导图</span>
                                        <button onClick={() => setMindmapExpanded(true)} className="text-xs font-medium text-zinc-500 hover:text-zinc-700 bg-zinc-50 hover:bg-zinc-100 px-3 py-1 rounded-full transition-all flex items-center gap-1">
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                                            </svg>
                                            放大
                                        </button>
                                    </div>
                                    <svg ref={mindmapRef} className="w-full" style={{ height: '500px' }}></svg>
                                    <details className="mt-2">
                                        <summary className="text-xs text-zinc-400 cursor-pointer hover:text-zinc-600">查看原文</summary>
                                        <pre className="mt-2 text-xs text-zinc-500 whitespace-pre-wrap leading-relaxed">{toolState.result.data}</pre>
                                    </details>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {(() => {
                                        const raw = typeof toolState.result.data === 'string' ? toolState.result.data : '';
                                        if (!raw.trim()) return null;
                                        return renderResultBlocks(raw);
                                    })()}
                                    {!toolState.result.streaming && toolState.result.sources?.length > 0 && (
                                        <div className="pt-2 border-t border-zinc-100 text-[11px] text-zinc-400">
                                            引用章节：{toolState.result.sources.map(s => s.chapter_title).join('、')}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 工具卡片（无工具激活时显示） */}
                    {!activeToolId && !toolState?.loading && !toolState?.result && tools.map((tool) => (
                        <button
                            key={tool.id}
                            onClick={() => handleToolCardClick(tool.id)}
                            disabled={!currentBook}
                            className={`group relative w-full rounded-xl border bg-white p-4 text-left transition-all duration-200 border-zinc-200 hover:border-zinc-300
                                ${!currentBook ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md'}
                                disabled:hover:translate-y-0 disabled:hover:shadow-none`}
                        >
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-zinc-50 text-zinc-500">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tool.icon} />
                                    </svg>
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-zinc-700">{tool.label}</h3>
                                    <p className="text-xs text-zinc-400 mt-0.5">{tool.desc}</p>
                                </div>
                            </div>
                        </button>
                    ))}

                    {/* 分隔线 + 收藏夹 */}
                    <div className="border-t border-zinc-100 pt-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
                                收藏夹
                                {favorites.length > 0 && <span className="ml-1.5 text-zinc-300">({favorites.length})</span>}
                            </h3>
                            {selectedFavs.length > 0 && (
                                <button onClick={exportFavorites} className="text-xs text-zinc-500 hover:text-zinc-700 font-medium">
                                    导出选中
                                </button>
                            )}
                        </div>

                        {favorites.length === 0 ? (
                            <div className="text-center py-6">
                                <svg className="w-8 h-8 mx-auto text-zinc-200 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                                </svg>
                                <p className="text-xs text-zinc-300">暂无收藏</p>
                                <p className="text-[11px] text-zinc-200 mt-1">在对话或AI工具结果中点击☆按钮收藏</p>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                                {favorites.map((fav) => (
                                    <div key={fav.id}
                                        className={`group rounded-lg border p-3 transition-all cursor-pointer ${selectedFavs.includes(fav.id) ? 'border-zinc-300 bg-zinc-50' : 'border-zinc-100 hover:border-zinc-200'}`}
                                        onClick={() => toggleFavSelect(fav.id)}
                                    >
                                        <div className="flex items-start gap-2">
                                            <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${selectedFavs.includes(fav.id) ? 'bg-zinc-800 border-zinc-800' : 'border-zinc-300'}`}>
                                                {selectedFavs.includes(fav.id) && (
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
                                                {fav.savedAt && (
                                                    <p className="text-[10px] text-zinc-300 mt-1">{fav.savedAt}</p>
                                                )}
                                            </div>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onRemoveFavorite(fav.id); }}
                                                className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-300 hover:text-red-500 transition-all"
                                            >
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* 思维导图全屏弹窗 */}
            {mindmapExpanded && (
                <div onClick={() => setMindmapExpanded(false)} className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', animation: 'fade-in 0.2s ease-out' }}>
                    <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-3xl shadow-2xl border border-zinc-200 flex flex-col overflow-hidden" style={{ width: '92vw', height: '90vh' }}>
                        <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
                            <h2 className="text-base font-serif-heading font-semibold text-zinc-800 truncate">
                                {(cleanMindmapData(toolState.result.data || '')).split('\n')[0]?.replace(/^#\s*/, '') || '思维导图'}
                            </h2>
                            <button onClick={() => setMindmapExpanded(false)} className="p-2 rounded-full hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-all">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-auto p-4">
                            <svg ref={overlayMindmapRef} className="w-full h-full"></svg>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default RightPanel;
