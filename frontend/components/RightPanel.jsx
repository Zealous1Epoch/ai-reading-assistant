function RightPanel({ currentBook, currentChapter, toolState, onRunTool, onBackToTools, favorites, onRemoveFavorite }) {
    const [selectedFavs, setSelectedFavs] = useState([]);
    const [toolView, setToolView] = useState('cards');
    const [toolInput, setToolInput] = useState('');
    const [pendingToolId, setPendingToolId] = useState(null);

    const needsInput = { summarize: true, debate: true };

    const tools = [
        { id: 'summarize', label: '总结', desc: '整本书或指定章节的详细总结', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
        { id: 'background', label: '背景调研', desc: '探索书籍的时代与学术背景', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
        { id: 'questions', label: '读书十问', desc: '十个深度问题帮你吃透一本书', icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
        { id: 'mindmap', label: '思维导图', desc: '可视化的知识框架与逻辑脉络', icon: 'M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4' },
        { id: 'recommend', label: '书籍推荐', desc: '推荐同主题的好书', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
        { id: 'debate', label: '芒格辩论', desc: '跨学科视角正反辩论看清观点', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
    ];

    const cardStyles = {
        summarize: 'hover:border-zinc-300',
        background: 'hover:border-zinc-300',
        questions: 'hover:border-zinc-300',
        mindmap: 'hover:border-zinc-300',
        recommend: 'hover:border-zinc-300',
        debate: 'hover:border-zinc-300'
    };

    const iconStyles = {
        summarize: 'bg-zinc-50 text-zinc-500',
        background: 'bg-zinc-50 text-zinc-500',
        questions: 'bg-zinc-50 text-zinc-500',
        mindmap: 'bg-zinc-50 text-zinc-500',
        recommend: 'bg-zinc-50 text-zinc-500',
        debate: 'bg-zinc-50 text-zinc-500'
    };

    const toggleFavSelect = (id) => {
        setSelectedFavs(prev =>
            prev.includes(id) ? prev.filter(fid => fid !== id) : [...prev, id]
        );
    };

    const exportFavorites = () => {
        const toExport = favorites.filter(f => selectedFavs.includes(f.id));
        if (toExport.length === 0) { alert('请先勾选要导出的收藏'); return; }
        const content = toExport.map(f =>
            `=== 收藏问答 ===\n保存时间: ${f.savedAt || '未知'}\n\n问: ${f.question}\n\n答: ${f.answer}\n\n---\n`
        ).join('\n');
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
        if (toolState?.result && !toolState?.loading) {
            setToolView('result');
        }
    }, [toolState?.result]);

    const toolLabel = {
        summarize: '总结', background: '背景调研', questions: '读书十问',
        mindmap: '思维导图', recommend: '书籍推荐', debate: '芒格辩论'
    };

    const inputPlaceholder = {
        summarize: '输入总结范围（如：整本书、第3章、第1-5章）',
        debate: '输入你书中想辩论的观点'
    };

    const mindmapRef = useRef(null);
    useEffect(() => {
        if (toolState?.toolId === 'mindmap' && toolState?.result?.data && !toolState?.loading) {
            const timer = setTimeout(() => {
                if (mindmapRef.current && window.markmap) {
                    const { Transformer } = window.markmap;
                    const { Markmap } = window.markmap;
                    try {
                        const transformer = new Transformer();
                        const { root } = transformer.transform(toolState.result.data);
                        mindmapRef.current.innerHTML = '';
                        Markmap.create(mindmapRef.current, { maxWidth: 300 }, root);
                    } catch (e) {
                        console.error('markmap 渲染失败:', e);
                    }
                }
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [toolState?.result, toolState?.loading, toolState?.toolId]);

    const activeToolId = toolState?.toolId || pendingToolId;

    const handleBackToCards = () => {
        onBackToTools();
        setToolView('cards');
        setPendingToolId(null);
    };

    return (
        <div className="w-80 bg-white rounded-3xl border border-zinc-200 flex flex-col h-full flex-shrink-0 overflow-hidden">
            {/* 头部 */}
            <div className="px-5 pt-5 pb-3 border-b border-zinc-100 flex items-center justify-between">
                {activeToolId ? (
                    <>
                        <button
                            onClick={handleBackToCards}
                            className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-700 transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                            返回
                        </button>
                        <span className="text-sm font-medium text-zinc-700">{toolLabel[activeToolId] || activeToolId}</span>
                    </>
                ) : (
                    <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">AI 工具</h2>
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
                                type="text"
                                value={toolInput}
                                onChange={(e) => setToolInput(e.target.value)}
                                onKeyDown={handleInputKeyDown}
                                placeholder={inputPlaceholder[activeToolId] || '请输入...'}
                                className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-400"
                                autoFocus
                            />
                            <button
                                onClick={handleInputSubmit}
                                disabled={!toolInput.trim()}
                                className="px-4 py-2 bg-zinc-800 text-white rounded-full text-sm font-medium hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                确定
                            </button>
                        </div>
                    </div>
                )}

                {/* 工具加载视图 */}
                {activeToolId && toolState?.loading && (
                    <div className="flex flex-col items-center justify-center py-10 animate-fade-in">
                        <div className="animate-spin h-8 w-8 border-2 border-zinc-300 border-t-transparent rounded-full mb-3"></div>
                        <p className="text-xs text-zinc-400">AI 处理中...</p>
                        <p className="text-xs text-zinc-300 mt-1">{toolLabel[activeToolId]}</p>
                    </div>
                )}

                {/* 工具结果视图 */}
                {activeToolId && toolState?.result && !toolState?.loading && (
                    <div className="animate-fade-in">
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
                        ) : activeToolId === 'mindmap' ? (
                            <div>
                                <svg ref={mindmapRef} className="w-full" style={{ height: '400px' }}></svg>
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

                                    // 1. 转换 markdown 表格为列表
                                    const convertTables = (text) => {
                                        const lines = text.split('\n');
                                        const out = [];
                                        let inTable = false, headers = [];
                                        for (let i = 0; i < lines.length; i++) {
                                            const t = lines[i].trim();
                                            if (/^\|.+\|$/.test(t)) {
                                                const cells = t.split('|').filter(c => c.trim()).map(c => c.trim());
                                                // 跳过分隔行
                                                if (cells.every(c => /^[-]{2,}$/.test(c.replace(/\s/g, '')))) {
                                                    inTable = true; continue; }
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
                                    };
                                    const cleaned = convertTables(raw);

                                    // 2. 转 **bold** → <strong>，再移除残余 * #
                                    const processText = (text) => {
                                        const parts = text.split(/(\*\*[^*]+\*\*)/g);
                                        return parts.map((part, j) => {
                                            const m = part.match(/^\*\*([^*]+)\*\*$/);
                                            return m
                                                ? React.createElement('strong', { key: j, className: 'font-semibold' }, m[1])
                                                : part.replace(/[*#]/g, '');
                                        });
                                    };

                                    // 3. 渲染单行
                                    const renderLine = (line, idx, opts = {}) => {
                                        const { isTitle, isBody } = opts;
                                        const t = line.trim();
                                        if (!t) return null;
                                        const afterH = t.replace(/^#{1,3}\s+/, '');

                                        if (isTitle) {
                                            const tm = afterH.match(/^(\d+[\.\、]|[一二三四五六七八九十]+[、\.])\s*(.*)/);
                                            return React.createElement('p', { key: idx, className: 'text-base font-bold text-zinc-900 leading-snug' },
                                                tm ? [tm[1] + ' ', ...processText(tm[2])] : processText(afterH));
                                        }

                                        const sbm = t.match(/^(\s{2,})[-*]\s+(.*)/);
                                        if (sbm) return React.createElement('p', { key: idx, className: 'text-sm text-zinc-600 leading-relaxed pl-7 mt-1.5' }, '◦ ', ...processText(sbm[2]));

                                        const bm = t.match(/^[-*]\s+(.*)/);
                                        if (bm) return React.createElement('p', { key: idx, className: 'text-sm text-zinc-700 leading-relaxed pl-5 mt-1.5' }, '· ', ...processText(bm[1]));

                                        const nm = t.match(/^(\d+[\.\、])\s*(.*)/);
                                        if (nm) return React.createElement('p', { key: idx, className: 'text-sm text-zinc-700 leading-relaxed pl-5 mt-1.5' }, nm[1] + ' ', ...processText(nm[2]));

                                        if (isBody) return React.createElement('p', { key: idx, className: 'text-sm text-zinc-700 leading-relaxed mt-1.5 text-indent-2' }, ...processText(afterH));

                                        return React.createElement('p', { key: idx, className: 'text-sm text-zinc-700 leading-relaxed mt-1.5' }, ...processText(afterH));
                                    };

                                    const blocks = cleaned.split(/(?=^\s*\d+[\.\、]|^[一二三四五六七八九十]+[、\.]|^#{1,3}\s+)/m).filter(b => b.trim());

                                    if (blocks.length <= 1) {
                                        const paragraphs = cleaned.split(/\n\n+/).filter(b => b.trim());
                                        return paragraphs.map((para, i) => {
                                            const lines = para.split('\n').filter(l => l.trim());
                                            return React.createElement('div', { key: i, className: 'bg-white border border-zinc-100 rounded-xl p-4 shadow-sm' },
                                                lines.map((line, j) => renderLine(line, j, { isTitle: j === 0, isBody: j > 0 })));
                                        });
                                    }

                                    return blocks.map((block, i) => {
                                        const lines = block.split('\n').filter(l => l.trim());
                                        const title = renderLine(lines[0], 0, { isTitle: true });
                                        if (lines.length === 1) {
                                            return React.createElement('div', { key: i, className: 'bg-white border border-zinc-100 rounded-xl p-4 shadow-sm' }, title);
                                        }
                                        const body = lines.slice(1).map((line, j) => renderLine(line, j + 1, { isBody: true }));
                                        return React.createElement('div', { key: i, className: 'bg-white border border-zinc-100 rounded-xl shadow-sm overflow-hidden' }, [
                                            React.createElement('div', { key: 'h', className: 'px-4 pt-4 pb-2 border-b border-zinc-50' }, title),
                                            React.createElement('div', { key: 'b', className: 'px-4 pt-3 pb-4' }, body),
                                        ]);
                                    });
                                })()}
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
                        className={`group relative w-full rounded-xl border bg-white p-4 text-left transition-all duration-200
                            ${!currentBook ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md'}
                            border-zinc-200 ${cardStyles[tool.id]}
                            disabled:hover:translate-y-0 disabled:hover:shadow-none`}
                    >
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconStyles[tool.id]}`}>
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
                            <button
                                onClick={exportFavorites}
                                className="text-xs text-zinc-500 hover:text-zinc-700 font-medium"
                            >
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
                            <p className="text-[11px] text-zinc-200 mt-1">在对话中点击☆按钮收藏</p>
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                            {favorites.map((fav) => (
                                <div key={fav.id}
                                    className={`group rounded-lg border p-3 transition-all cursor-pointer
                                        ${selectedFavs.includes(fav.id) ? 'border-zinc-300 bg-zinc-50' : 'border-zinc-100 hover:border-zinc-200'}`}
                                    onClick={() => toggleFavSelect(fav.id)}
                                >
                                    <div className="flex items-start gap-2">
                                        <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors
                                            ${selectedFavs.includes(fav.id) ? 'bg-zinc-800 border-zinc-800' : 'border-zinc-300'}`}>
                                            {selectedFavs.includes(fav.id) && (
                                                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                                </svg>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-medium text-zinc-700 truncate">{fav.question}</p>
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
    );
}
