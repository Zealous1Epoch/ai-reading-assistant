const API_BASE = '';

function LeftPanel({ books, currentBook, currentChapter, selectedBookIds, onToggleBook, onSelectBook, onSelectChapter, onUploadBook, onUploadMultiple, onDeleteBook, uploading, chatMode }) {
    const [isDragging, setIsDragging] = useState(false);
    const [leftView, setLeftView] = useState('files');
    const [searchKeyword, setSearchKeyword] = useState('');
    const [searchResults, setSearchResults] = useState(null);
    const [searchLoading, setSearchLoading] = useState(false);
    const fileInputRef = useRef(null);
    const searchTimerRef = useRef(null);

    const handleBookClick = (book) => {
        onSelectBook(book);
        setLeftView('chapters');
    };

    const handleBack = () => {
        setLeftView('files');
    };

    const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = () => setIsDragging(false);

    const handleDrop = async (e) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) uploadFile(file);
    };

    const handleFileSelect = (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            onUploadMultiple(files);
        }
        e.target.value = '';
    };

    const uploadFile = (file) => {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['pdf', 'epub', 'txt'].includes(ext)) {
            alert('仅支持 PDF、EPUB、TXT 格式');
            return;
        }
        onUploadBook(file);
    };

    return (
        <div className="w-72 bg-white rounded-3xl border border-zinc-200 flex flex-col h-full flex-shrink-0 overflow-hidden">
            {leftView === 'files' ? (
                <>
                    {/* 头部 */}
                    <div className="px-5 pt-5 pb-3">
                        <div className="flex items-center justify-between mb-3">
                        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">来源</h2>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="text-xs font-medium text-zinc-500 hover:text-zinc-700 transition-colors"
                        >
                            + 添加
                        </button>
                    </div>
                    <div
                        className={`drop-zone border border-dashed rounded-xl p-3 text-center cursor-pointer transition-all
                            ${isDragging ? 'border-zinc-800 bg-zinc-50' : 'border-zinc-300 hover:border-zinc-400'}`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <svg className="w-5 h-5 mx-auto text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                        </svg>
                        <input ref={fileInputRef} type="file" accept=".pdf,.epub,.txt" multiple className="hidden" onChange={handleFileSelect} />
                    </div>
                    </div>

                    {/* 已选书籍提示（仅综合阅读模式显示） */}
                    {chatMode === 'cross' && selectedBookIds?.length > 0 && (
                        <div className="px-3 pb-1">
                            <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 bg-zinc-50 rounded-lg px-3 py-2">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>已选 {selectedBookIds.length} 本书</span>
                            </div>
                        </div>
                    )}

                    {/* 书籍列表 */}
                    <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-3">
                        <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider px-2 py-2">
                            {books.length > 0 ? `已上传 (${books.length})` : ''}
                        </div>
                        {uploading && (
                            <div className="flex flex-col items-center justify-center py-4 px-3">
                                <div className="flex items-center gap-2 text-zinc-400 text-sm mb-2">
                                    <div className="animate-spin h-4 w-4 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                                    {uploading.phase === 'uploading'
                                        ? `上传中 (${uploading.current}/${uploading.total})`
                                        : `分析中 (${uploading.current}/${uploading.total})`}
                                </div>
                                {uploading.ocrProgress && (
                                    <div className="w-full bg-zinc-100 rounded-full h-1.5 overflow-hidden">
                                        <div
                                            className="h-full bg-zinc-400 rounded-full transition-all duration-500"
                                            style={{ width: `${Math.round((uploading.ocrProgress.current / uploading.ocrProgress.total) * 100)}%` }}
                                        ></div>
                                    </div>
                                )}
                                {uploading.ocrProgress && (
                                    <p className="text-[10px] text-zinc-400 mt-1">
                                        OCR {uploading.ocrFilename || ''}: {uploading.ocrProgress.current}/{uploading.ocrProgress.total} 页
                                    </p>
                                )}
                            </div>
                        )}
                        {!uploading && books.length === 0 && (
                            <div className="text-center text-zinc-300 text-sm py-8">
                                <p>暂无书籍</p>
                            </div>
                        )}
                        {books.map((book) => {
                            const isSelected = currentBook?.book_id === book.book_id;
                            return (
                                <div key={book.book_id} className="mb-1">
                                    <div
                                        onClick={() => handleBookClick(book)}
                                        className={`group px-3 py-2.5 rounded-lg cursor-pointer transition-all
                                            ${isSelected ? 'bg-zinc-50 ring-1 ring-zinc-200' : 'hover:bg-zinc-50'}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            {chatMode === 'cross' && (
                                                <div
                                                    onClick={(e) => { e.stopPropagation(); onToggleBook(book.book_id); }}
                                                    className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer
                                                        ${selectedBookIds.includes(book.book_id)
                                                            ? 'bg-zinc-800 border-zinc-800'
                                                            : 'border-zinc-300 hover:border-zinc-400'}`}
                                                >
                                                    {selectedBookIds.includes(book.book_id) && (
                                                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                                        </svg>
                                                    )}
                                                </div>
                                            )}
                                            <div className="w-9 h-11 rounded-lg flex items-center justify-center text-[11px] font-bold flex-shrink-0 bg-zinc-50 text-zinc-400 border border-zinc-100">
                                                {book.file_format || 'TXT'}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className={`text-sm font-medium truncate ${isSelected ? 'text-zinc-800' : 'text-zinc-600'}`}>
                                                    {book.title}
                                                </p>
                                                <p className="text-xs text-zinc-400 mt-0.5">
                                                    {book.total_chapters || 0} 章 · {Math.round((book.total_words || 0) / 1000)}k 字
                                                </p>
                                            </div>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); if (confirm(`确定删除「${book.title}」？`)) onDeleteBook(book.book_id); }}
                                                className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-all flex-shrink-0"
                                                title="删除此书"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            ) : (
                <>
                    {/* 返回按钮 */}
                    <div className="px-4 pt-4 pb-2">
                        <button
                            onClick={handleBack}
                            className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-700 transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                            返回
                        </button>
                    </div>

                    {/* 当前书籍信息 */}
                    {currentBook && (
                        <div className="px-4 pb-3">
                            <div className="flex items-center gap-3 px-3 py-2.5">
                                <div className="w-9 h-11 rounded-lg flex items-center justify-center text-[11px] font-bold flex-shrink-0 bg-zinc-50 text-zinc-400 border border-zinc-100">
                                    {currentBook.file_format || 'TXT'}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-base font-serif-heading font-semibold text-zinc-800 truncate">{currentBook.title}</p>
                                    <p className="text-xs text-zinc-400 mt-0.5">
                                        {currentBook.total_chapters || 0} 章 · {Math.round((currentBook.total_words || 0) / 1000)}k 字
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* 关键词搜索 */}
                    <div className="px-4 pb-2">
                        <div className="relative">
                            <input
                                type="text"
                                value={searchKeyword}
                                onChange={(e) => {
                                    setSearchKeyword(e.target.value);
                                    clearTimeout(searchTimerRef.current);
                                    const val = e.target.value.trim();
                                    if (val.length < 2) { setSearchResults(null); return; }
                                    setSearchLoading(true);
                                    searchTimerRef.current = setTimeout(async () => {
                                        try {
                                            const res = await fetch(`${API_BASE}/search/fulltext?keyword=${encodeURIComponent(val)}&book_id=${currentBook.book_id}&limit=10`);
                                            const data = await res.json();
                                            setSearchResults(data.matches || []);
                                        } catch { setSearchResults([]); }
                                        finally { setSearchLoading(false); }
                                    }, 300);
                                }}
                                placeholder="搜索关键词..."
                                className="w-full px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 placeholder:text-zinc-400"
                            />
                            {searchLoading && (
                                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                                    <div className="animate-spin h-3 w-3 border-2 border-zinc-300 border-t-transparent rounded-full"></div>
                                </div>
                            )}
                        </div>
                        {searchResults && searchResults.length > 0 && (
                            <div className="mt-1.5 max-h-40 overflow-y-auto bg-white border border-zinc-200 rounded-lg divide-y divide-zinc-50">
                                {searchResults.slice(0, 8).map((m, i) => (
                                    <div
                                        key={i}
                                        onClick={() => {
                                            const ch = currentBook?.chapters?.find(c => c.chapter_id === m.chapter_id);
                                            if (ch) { onSelectChapter(ch); setSearchKeyword(''); setSearchResults(null); }
                                        }}
                                        className="px-2.5 py-1.5 cursor-pointer hover:bg-zinc-50 transition-colors"
                                    >
                                        <p className="text-[11px] font-medium text-zinc-700 truncate">{m.chapter_title}</p>
                                        <p className="text-[10px] text-zinc-400 leading-relaxed line-clamp-1">{m.snippet}</p>
                                    </div>
                                ))}
                            </div>
                        )}
                        {searchResults && searchResults.length === 0 && searchKeyword.trim().length >= 2 && (
                            <p className="text-[11px] text-zinc-400 px-1 mt-1">未找到匹配结果</p>
                        )}
                    </div>

                    {/* 章节列表 */}
                    <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-3">
                        <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider px-2 py-2">
                            目录
                        </div>
                        {currentBook?.chapters?.length > 0 ? (
                            <div className="space-y-0.5">
                                {(() => {
                                    const toc = currentBook.toc || [];
                                    // 如果无toc，退化为章节平铺
                                    if (toc.length === 0) {
                                        return currentBook.chapters.map(ch => (
                                            <div
                                                key={ch.chapter_id}
                                                onClick={() => onSelectChapter(ch)}
                                                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm
                                                    ${currentChapter?.chapter_id === ch.chapter_id
                                                        ? 'bg-zinc-50 text-zinc-800 font-medium'
                                                        : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50'}`}
                                            >
                                                <span className="truncate">{ch.title}</span>
                                            </div>
                                        ));
                                    }
                                    // 用toc渲染层级目录，按顺序编号
                                    let chapterNum = 0;
                                    return toc.map((item, i) => {
                                        const isL1 = (item.level || 1) === 1;
                                        if (isL1) chapterNum++;
                                        const ch = currentBook.chapters?.find(c => c.title === item.title);
                                        const isSelected = ch && currentChapter?.chapter_id === ch.chapter_id;
                                        return (
                                            <div
                                                key={i}
                                                onClick={() => { if (ch) onSelectChapter(ch); }}
                                                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm
                                                    ${isSelected ? 'bg-zinc-50 text-zinc-800 font-medium' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50'}
                                                    ${!isL1 ? 'pl-8' : ''}`}
                                            >
                                                {isL1 ? (
                                                    <span className="text-zinc-400 text-xs min-w-[1.2em]">{chapterNum}.</span>
                                                ) : (
                                                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ml-0.5
                                                        ${isSelected ? 'bg-zinc-800' : 'bg-zinc-300'}`}></span>
                                                )}
                                                <span className="truncate">{item.title}</span>
                                            </div>
                                        );
                                    });
                                })()}
                            </div>
                        ) : (
                            <div className="text-center text-zinc-300 text-sm py-8">
                                <p>暂无章节</p>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
