import { useState, useRef } from 'react';

const API_BASE = '';

const ListIcon = ({ className }) => (
    <svg className={className || 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
    </svg>
);

// 目录侧栏：常驻左栏（展开 216px / 收起 36px 细栏）
// toc 层级渲染优先（匹配率<0.8 降级平铺）+ 本书全文搜索 + 底部书籍摘要
function TocRail({ book, currentChapter, onSelectChapter, open, onToggle }) {
    const [keyword, setKeyword] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);
    const timerRef = useRef(null);

    const runSearch = (val) => {
        clearTimeout(timerRef.current);
        if (val.trim().length < 2) { setResults(null); return; }
        setSearching(true);
        timerRef.current = setTimeout(async () => {
            try {
                const res = await fetch(`${API_BASE}/search/fulltext?keyword=${encodeURIComponent(val.trim())}&book_id=${book.book_id}&limit=20`);
                const data = await res.json();
                setResults(data.matches || []);
            } catch { setResults([]); }
            finally { setSearching(false); }
        }, 300);
    };

    const goChapter = (ch) => {
        onSelectChapter(ch);
        // 从搜索结果跳转后回到目录列表
        setKeyword('');
        setResults(null);
    };

    if (!open) {
        const count = (book?.chapters || []).length;
        return (
            <div className="w-9 flex-shrink-0 bg-white rounded-2xl border border-zinc-200 flex flex-col items-center py-2 gap-1">
                <button onClick={onToggle} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50 transition-all" title="展开目录">
                    <ListIcon />
                </button>
                {count > 0 && (
                    <button onClick={onToggle} className="text-[10px] text-zinc-300 hover:text-zinc-500 tabular-nums">
                        {count}
                    </button>
                )}
            </div>
        );
    }

    const chapters = book.chapters || [];
    const toc = book.toc || [];
    const tocMatchRate = toc.length > 0
        ? toc.filter(item => chapters.some(c => c.title === item.title)).length / toc.length
        : 0;

    const renderList = () => {
        if (results !== null) {
            return results.length === 0 ? (
                <p className="text-xs text-zinc-300 text-center py-6">未找到</p>
            ) : results.map((m, i) => (
                <div
                    key={i}
                    onClick={() => {
                        const ch = chapters.find(c => c.chapter_id === m.chapter_id);
                        if (ch) goChapter(ch);
                    }}
                    className="px-3 py-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors"
                >
                    <p className="text-xs font-medium text-zinc-700 truncate">{m.chapter_title}</p>
                    <p className="text-[11px] text-zinc-400 leading-relaxed line-clamp-2 mt-0.5">{m.snippet}</p>
                </div>
            ));
        }
        if (chapters.length === 0) {
            return <p className="text-xs text-zinc-300 text-center py-6">暂无章节</p>;
        }
        if (toc.length === 0 || tocMatchRate < 0.8) {
            return chapters.map(ch => {
                const selected = currentChapter?.chapter_id === ch.chapter_id;
                return (
                    <div
                        key={ch.chapter_id}
                        onClick={() => goChapter(ch)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm ${selected ? 'bg-zinc-50 text-zinc-800 font-medium' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50'}`}
                    >
                        <span className="truncate">{ch.title}</span>
                    </div>
                );
            });
        }
        const orderOfTitle = new Map(chapters.map((c, i) => [c.title, i]));
        const sortedToc = toc
            .filter(item => orderOfTitle.has(item.title))
            .sort((a, b) => orderOfTitle.get(a.title) - orderOfTitle.get(b.title));
        let chapterNum = 0;
        return sortedToc.map((item, i) => {
            const isL1 = (item.level || 1) === 1;
            if (isL1) chapterNum++;
            const ch = chapters.find(c => c.title === item.title);
            const selected = ch && currentChapter?.chapter_id === ch.chapter_id;
            return (
                <div
                    key={i}
                    onClick={() => { if (ch) goChapter(ch); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm ${selected ? 'bg-zinc-50 text-zinc-800 font-medium' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50'} ${!isL1 ? 'pl-8' : ''}`}
                >
                    {isL1 ? (
                        <span className="text-zinc-400 text-xs min-w-[1.2em] tabular-nums">{chapterNum}.</span>
                    ) : (
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ml-0.5 ${selected ? 'bg-zinc-800' : 'bg-zinc-300'}`}></span>
                    )}
                    <span className="truncate">{item.title}</span>
                </div>
            );
        });
    };

    return (
        <div className="flex-shrink-0 bg-white rounded-2xl border border-zinc-200 flex flex-col overflow-hidden" style={{ width: '216px' }}>
            <div className="px-3.5 pt-3.5 pb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">目录</span>
                <button onClick={onToggle} className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-700 hover:bg-zinc-50 transition-all" title="收起">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    </svg>
                </button>
            </div>
            <div className="px-3 pb-2 flex-shrink-0">
                <div className="relative">
                    <input
                        type="text"
                        value={keyword}
                        onChange={e => { setKeyword(e.target.value); runSearch(e.target.value); }}
                        placeholder="搜索本书"
                        className="w-full px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 placeholder:text-zinc-400"
                    />
                    {searching && (
                        <div className="absolute right-2 top-1/2 -translate-y-1/2">
                            <div className="animate-spin h-3 w-3 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                        </div>
                    )}
                </div>
                {results !== null && (
                    <button onClick={() => { setKeyword(''); setResults(null); }} className="text-[11px] text-zinc-400 hover:text-zinc-600 mt-1">
                        ← 返回目录（{results.length} 条结果）
                    </button>
                )}
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2 space-y-0.5">
                {renderList()}
            </div>
            {book.summary && results === null && (
                <div className="flex-shrink-0 border-t border-zinc-100 px-3.5 py-2.5 max-h-32 overflow-y-auto scrollbar-thin">
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">书籍摘要</p>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">{book.summary}</p>
                </div>
            )}
        </div>
    );
}

export default TocRail;
