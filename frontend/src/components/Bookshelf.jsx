import { useState, useRef, useEffect } from 'react';

const API_BASE = '';

// 按 book_id 哈希取封面配色（确定性：同一本书永远同一块颜色）
const PALETTES = [
    ['#1e293b', '#0f172a'], ['#7c2d12', '#431407'], ['#14532d', '#052e16'],
    ['#312e81', '#1e1b4b'], ['#701a75', '#4a044e'], ['#713f12', '#422006'],
    ['#0f766e', '#134e4a'], ['#7f1d1d', '#450a0a'], ['#334155', '#1e293b'],
    ['#4c1d95', '#2e1065'], ['#155e75', '#083344'], ['#365314', '#1a2e05'],
];
function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function Cover({ book }) {
    const [c1, c2] = PALETTES[hashStr(book.book_id || book.title) % PALETTES.length];
    return (
        <div
            className="relative w-full rounded-xl overflow-hidden shadow-md group-hover:shadow-xl transition-shadow"
            style={{ aspectRatio: '3 / 4.2', background: `linear-gradient(160deg, ${c1} 0%, ${c2} 100%)` }}
        >
            {/* 书脊压痕 + 顶部微光 */}
            <div className="absolute inset-y-0 left-[7%] w-px bg-white/15"></div>
            <div className="absolute inset-x-0 left-[7%] top-0 h-px bg-white/10"></div>
            <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 60% at 30% 0%, rgba(255,255,255,0.10), transparent 60%)' }}></div>
            {/* 封面排版 */}
            <div className="absolute inset-0 pl-[13%] pr-3 flex flex-col">
                <div className="pt-[12%]">
                    <p className="font-serif-heading font-bold text-white/95 leading-snug line-clamp-5" style={{ fontSize: 'clamp(13px, 1.35vw, 19px)' }}>
                        {book.title}
                    </p>
                    <div className="mt-2 h-px w-7 bg-white/30"></div>
                    {book.author && (
                        <p className="mt-2 text-[10px] text-white/55 truncate">{book.author}</p>
                    )}
                </div>
                <div className="mt-auto pb-[9%] flex items-end justify-between">
                    <span className="text-[9px] text-white/35 tracking-widest uppercase">{book.file_format || ''}</span>
                    <span className="text-[9px] text-white/45 tabular-nums">{book.total_chapters || 0} 章</span>
                </div>
            </div>
        </div>
    );
}

// 书架首页：网格封面 + 全局语义搜索 + 上传（含右下角进度浮层）+ hover 删除
function Bookshelf({ books, progressMap, uploading, onEnterBook, onUploadMultiple, onDeleteBook }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileRef = useRef(null);
    const timerRef = useRef(null);

    useEffect(() => () => clearTimeout(timerRef.current), []);

    const onQueryChange = (val) => {
        setQuery(val);
        clearTimeout(timerRef.current);
        if (val.trim().length < 2) { setResults(null); return; }
        setSearching(true);
        timerRef.current = setTimeout(async () => {
            try {
                const res = await fetch(`${API_BASE}/search/semantic?query=${encodeURIComponent(val.trim())}&n_results=12`);
                const data = await res.json();
                setResults(Array.isArray(data) ? data : []);
            } catch { setResults([]); }
            finally { setSearching(false); }
        }, 400);
    };

    const pickFiles = (fileList) => {
        const files = Array.from(fileList).filter(f => /\.(pdf|epub|txt)$/i.test(f.name));
        const skipped = Array.from(fileList).length - files.length;
        if (skipped > 0) alert(`已忽略 ${skipped} 个不支持的文件（仅 PDF / EPUB / TXT）`);
        if (files.length > 0) onUploadMultiple(files);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) pickFiles(e.dataTransfer.files);
    };

    const progressOf = (book) => {
        const p = progressMap[book.book_id];
        if (!p) return null;
        const idx = (book.chapters || []).findIndex(c => c.chapter_id === p.chapterId);
        return { ...p, idx, total: book.total_chapters || book.chapters?.length || 0 };
    };

    return (
        <div
            className="h-screen overflow-y-auto scrollbar-thin bg-zinc-50"
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
        >
            {dragOver && (
                <div className="fixed inset-3 z-50 rounded-3xl border-2 border-dashed border-zinc-400 bg-white/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
                    <p className="text-sm text-zinc-500">松手上传 · PDF / EPUB / TXT</p>
                </div>
            )}

            <div className="max-w-6xl mx-auto px-6 pt-10 pb-16">
                {/* 顶行 */}
                <div className="flex items-end justify-between gap-4 mb-8 flex-wrap">
                    <div>
                        <h1 className="text-2xl font-serif-heading font-bold text-zinc-900">书架</h1>
                        <p className="text-xs text-zinc-400 mt-1 tabular-nums">{books.length} 本</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <input
                                type="text"
                                value={query}
                                onChange={e => onQueryChange(e.target.value)}
                                placeholder="搜书里的内容"
                                className="w-64 pl-8 pr-3 py-2 bg-white border border-zinc-200 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-300"
                            />
                            <svg className="w-4 h-4 text-zinc-300 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            {searching && (
                                <div className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin h-3.5 w-3.5 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                            )}
                        </div>
                        <button
                            onClick={() => fileRef.current?.click()}
                            disabled={!!uploading}
                            className="flex items-center gap-1.5 px-4 py-2 bg-zinc-800 text-white rounded-full text-sm font-medium hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            上传
                        </button>
                        <input ref={fileRef} type="file" accept=".pdf,.epub,.txt" multiple className="hidden" onChange={e => { pickFiles(e.target.files); e.target.value = ''; }} />
                    </div>
                </div>

                {/* 搜索结果 */}
                {results !== null ? (
                    <div>
                        <p className="text-xs text-zinc-400 mb-3 tabular-nums">{results.length} 处相关段落</p>
                        {results.length === 0 ? (
                            <p className="text-sm text-zinc-300 text-center py-16">没有匹配的内容</p>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {results.map((r, i) => {
                                    const known = books.some(b => b.book_id === r.book_id);
                                    return (
                                        <button
                                            key={i}
                                            onClick={() => { if (known) onEnterBook(r.book_id, r.chapter_id); }}
                                            disabled={!known}
                                            className="text-left bg-white border border-zinc-200 rounded-2xl p-4 transition-all disabled:opacity-40 enabled:hover:border-zinc-300 enabled:hover:shadow-md"
                                        >
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <span className="text-xs font-semibold text-zinc-700 truncate">{r.book_title}</span>
                                                <span className="text-zinc-200 flex-shrink-0">·</span>
                                                <span className="text-[11px] text-zinc-400 truncate">{r.title}</span>
                                                <span className="ml-auto text-[10px] text-zinc-300 tabular-nums flex-shrink-0">{Math.round(r.relevance_score * 100)}% 相关</span>
                                            </div>
                                            <p className="text-xs text-zinc-500 leading-relaxed line-clamp-3">{r.content_snippet}</p>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : books.length === 0 ? (
                    /* 空书架 */
                    <div
                        onClick={() => fileRef.current?.click()}
                        className="border-2 border-dashed border-zinc-200 hover:border-zinc-300 rounded-3xl py-24 text-center cursor-pointer transition-colors"
                    >
                        <svg className="w-10 h-10 mx-auto text-zinc-200 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                        </svg>
                        <p className="text-sm text-zinc-400">上传第一本书</p>
                        <p className="text-xs text-zinc-300 mt-1">PDF · EPUB · TXT，拖入此页亦可</p>
                    </div>
                ) : (
                    /* 书网格 */
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-x-5 gap-y-8">
                        {books.map(book => {
                            const p = progressOf(book);
                            return (
                                <div key={book.book_id} className="group relative">
                                    <button onClick={() => onEnterBook(book.book_id)} className="block w-full text-left">
                                        <Cover book={book} />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); if (confirm(`删除《${book.title}》？将同时删除其章节、向量索引与对话记录。`)) onDeleteBook(book.book_id); }}
                                        className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/25 text-white/70 opacity-0 group-hover:opacity-100 hover:bg-red-600 hover:text-white transition-all backdrop-blur-sm"
                                        title="删除此书"
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1-1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                    </button>
                                    <div className="mt-2.5 px-0.5">
                                        {p ? (
                                            <>
                                                <p className="text-[11px] text-zinc-500 truncate">读到 {p.chapterTitle || '进行中'}</p>
                                                <div className="mt-1.5 h-0.5 bg-zinc-200/70 rounded-full overflow-hidden">
                                                    <div className="h-full bg-zinc-400 rounded-full" style={{ width: `${p.total > 0 && p.idx >= 0 ? Math.round(((p.idx + 1) / p.total) * 100) : 0}%` }}></div>
                                                </div>
                                            </>
                                        ) : (
                                            <p className="text-[11px] text-zinc-300">{Math.round((book.total_words || 0) / 1000)}k 字</p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 上传进度浮层 */}
            {uploading && (
                <div className="fixed bottom-5 right-5 z-50 w-72 bg-white rounded-2xl border border-zinc-200 shadow-2xl px-4 py-3.5 animate-fade-in">
                    <div className="flex items-center gap-2 mb-2">
                        <div className="animate-spin h-3.5 w-3.5 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                        <span className="text-xs font-medium text-zinc-600 tabular-nums">
                            {uploading.phase === 'uploading' ? `上传中 ${uploading.current}/${uploading.total}` : `解析中 ${uploading.current}/${uploading.total}`}
                        </span>
                    </div>
                    <div className="h-1 bg-zinc-100 rounded-full overflow-hidden">
                        <div className="h-full bg-zinc-500 rounded-full transition-all duration-500" style={{ width: `${uploading.total > 0 ? Math.round((uploading.current / uploading.total) * 100) : 5}%` }}></div>
                    </div>
                    {uploading.ocrProgress && (
                        <p className="text-[10px] text-zinc-400 mt-2 truncate tabular-nums">
                            OCR {uploading.ocrFilename || ''} {uploading.ocrProgress.current}/{uploading.ocrProgress.total} 页
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

export default Bookshelf;
