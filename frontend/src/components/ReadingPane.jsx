import { useState, useEffect, useRef } from 'react';

const API_BASE = '';

// 章节正文清洗：去掉 PDF 残留页码与乱码行
function cleanChapterContent(text) {
    return text
        .replace(/\[PAGE\s*\d+\]/gi, '')
        .split('\n')
        .filter(line => {
            const s = line.trim();
            if (!s) return true;
            if (/^[\d\s\.\,\-\+\=\(\)\[\]\{\}\/\\\|\&\*\%\$\#\@\!]+$/.test(s)) return false;
            const garbage = s.replace(/[a-zA-Z0-9一-鿿　-〿＀-￯\s.,;:!?()《》、，。；：？！—…·\t\-]/g, '');
            return garbage.length / s.length < 0.4;
        })
        .join('\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .replace(/ {3,}/g, '  ')
        .trim();
}

function ChapterParagraphs({ text }) {
    const cleaned = cleanChapterContent(text);
    let blocks = cleaned.split(/\n\n+/).filter(p => p.trim());
    // PDF 提取的书普遍没有空行（每个单换行就是一段）：此时整章会被并成一个巨型 block，
    // 而 CSS columns 无法在 break-inside-avoid 的块内分栏 → 双栏右列全空。退化为按行切段。
    if (blocks.length === 1 && blocks[0].includes('\n')) {
        blocks = blocks[0].split('\n').filter(b => b.trim());
    }
    return (
        <>
            {blocks.map((block, i) => {
                const lines = block.split('\n').filter(l => l.trim());
                if (lines.length === 0) return null;
                const firstLine = lines[0];
                const isHeading = /^(\d+[\.\、\)]\s*|第[一二三四五六七八九十百\d]+[章节卷部])\s*/.test(firstLine)
                    || (firstLine.length <= 22 && !/[。，；]$/.test(firstLine));
                // 长块不禁止断行，保证双栏可以在段内流动
                const avoid = block.length <= 300 ? 'break-inside-avoid' : '';
                if (isHeading) {
                    const bodyLines = lines.slice(1).filter(l => l.trim());
                    return (
                        <div key={i} data-p={i} className={`${avoid} mb-5`}>
                            <p className="text-lg font-serif-heading font-bold text-zinc-900 mb-2" style={{ breakAfter: 'avoid' }}>{firstLine}</p>
                            {bodyLines.map((l, j) => (
                                <p key={j} className="text-[15px] text-zinc-700 leading-8 mb-2" style={{ textIndent: '2em' }}>{l.trim()}</p>
                            ))}
                        </div>
                    );
                }
                return (
                    <p key={i} data-p={i} className={`text-[15px] text-zinc-700 leading-8 mb-3 ${avoid}`} style={{ textIndent: '2em' }}>
                        {block.trim()}
                    </p>
                );
            })}
        </>
    );
}

function ChapterNavButton({ dir, disabled, title, onClick }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-700 hover:bg-zinc-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            title={title}
        >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={dir === 'prev' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} />
            </svg>
        </button>
    );
}

// 阅读区：摘要条全宽置顶 + 正文；容器宽 >= 900px 时正文自动双栏（书页模式）
// citeTarget：句内引用跳章后的段落高亮目标 {chapter_id, snippet, nonce}
function ReadingPane({ currentBook, currentChapter, onSelectChapter, citeTarget }) {
    const [summary, setSummary] = useState(null);
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [summaryOpen, setSummaryOpen] = useState(true);
    // 听本章（v2.5）：POST /audio/chapter → 任务轮询 → mp3 播放条。edge-tts 免费接口，不占内部模型算力
    const [listen, setListen] = useState({ st: 'idle', msg: '', url: '' });
    const listenReqRef = useRef(0);

    useEffect(() => {
        // 切章即复位听书状态（后台合成不取消——成品落盘，下次进本章直接命中缓存）
        listenReqRef.current += 1;
        setListen({ st: 'idle', msg: '', url: '' });
    }, [currentChapter?.chapter_id]);

    const startListen = async () => {
        if (!currentBook || !currentChapter || listen.st === 'busy') return;
        const reqId = ++listenReqRef.current;
        const alive = () => listenReqRef.current === reqId;
        setListen({ st: 'busy', msg: '正在排队合成', url: '' });
        try {
            const res = await fetch('/audio/chapter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ book_id: currentBook.book_id, chapter_id: currentChapter.chapter_id }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.detail || `请求失败 ${res.status}`);
            if (d.status === 'done') {
                if (alive()) setListen({ st: 'ready', msg: '', url: d.url });
                return;
            }
            for (let i = 0; i < 900; i++) {
                await new Promise(r => setTimeout(r, 2000));
                if (!alive()) return;
                const t = await (await fetch(`/audio/task/${d.task_id}`)).json().catch(() => ({}));
                if (t.status === 'done') {
                    if (alive()) setListen({ st: 'ready', msg: '', url: t.url });
                    return;
                }
                if (t.status === 'error') throw new Error(t.error || '合成失败');
                if (alive() && t.progress) setListen(a => (a.st === 'busy' ? { ...a, msg: t.progress } : a));
            }
            throw new Error('合成超时，请稍后重试');
        } catch (e) {
            if (alive()) setListen({ st: 'err', msg: String(e.message || e), url: '' });
        }
    };
    const [twoCol, setTwoCol] = useState(false);
    // 正文容器用回调 state ref：章节内容异步到位后也能挂上 ResizeObserver（useRef+[] 会错过挂载时机）
    const [colBoxEl, setColBoxEl] = useState(null);
    const scrollRef = useRef(null);

    // 章节摘要（后端按章缓存）
    useEffect(() => {
        if (!currentChapter?.chapter_id) { setSummary(null); return; }
        let alive = true;
        setSummaryLoading(true);
        setSummary(null);
        fetch(`${API_BASE}/analysis/chapter/${currentChapter.chapter_id}/summary`)
            .then(res => res.json())
            .then(data => { if (alive) setSummary(data.summary ? data : null); })
            .catch(() => {})
            .finally(() => { if (alive) setSummaryLoading(false); });
        return () => { alive = false; };
    }, [currentChapter?.chapter_id]);

    // 换章回到顶部
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
    }, [currentChapter?.chapter_id]);

    // 引用角标跳转：在渲染段落中找到锚点子串 → 滚至居中并闪烁高亮；未命中则停留在章首（优雅回落）
    useEffect(() => {
        if (!citeTarget || !currentChapter || citeTarget.chapter_id !== currentChapter.chapter_id) return;
        if (!citeTarget.snippet) return;
        const box = scrollRef.current;
        if (!box) return;
        const norm = s => s.replace(/\s+/g, '');
        const want = norm(citeTarget.snippet);
        if (!want) return;
        // 正文段落随内容异步渲染，稍等一帧再找
        const timer = setTimeout(() => {
            box.querySelectorAll('.cite-flash').forEach(el => el.classList.remove('cite-flash'));
            const els = box.querySelectorAll('[data-p]');
            let target = null;
            for (const el of els) {
                if (norm(el.textContent).includes(want)) { target = el; break; }
            }
            if (!target) return;
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.add('cite-flash');
        }, 60);
        return () => clearTimeout(timer);
    }, [citeTarget?.nonce, currentChapter?.chapter_id, currentChapter?.content]);

    // 双栏判定：以正文容器实际宽度为准（与 AI 区/侧栏的展开状态天然联动）
    useEffect(() => {
        if (!colBoxEl || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) setTwoCol(e.contentRect.width >= 900);
        });
        ro.observe(colBoxEl);
        return () => ro.disconnect();
    }, [colBoxEl]);

    if (!currentBook) {
        return (
            <div className="flex-1 bg-white rounded-2xl border border-zinc-200 flex items-center justify-center min-w-0">
                <p className="text-sm text-zinc-300">书籍不存在</p>
            </div>
        );
    }

    const chapters = currentBook.chapters || [];
    const chapterIdx = currentChapter
        ? chapters.findIndex(c => c.chapter_id === currentChapter.chapter_id)
        : -1;
    const prev = chapterIdx > 0 ? chapters[chapterIdx - 1] : null;
    const next = chapterIdx >= 0 && chapterIdx < chapters.length - 1 ? chapters[chapterIdx + 1] : null;

    return (
        <div className="flex-1 min-w-0 bg-white rounded-2xl border border-zinc-200 flex flex-col overflow-hidden">
            {/* 章头：标题 + 字数 + 翻页 */}
            <div className="px-6 pt-4 pb-3 border-b border-zinc-100 flex-shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <h2 className="text-base font-serif-heading font-semibold text-zinc-900 truncate">
                        {currentChapter?.title || ''}
                    </h2>
                    {currentChapter?.word_count ? (
                        <span className="text-[11px] text-zinc-300 flex-shrink-0 tabular-nums">{currentChapter.word_count} 字</span>
                    ) : null}
                    <button
                        onClick={startListen}
                        disabled={!currentChapter || listen.st === 'busy'}
                        title="听本章"
                        data-listen-chapter
                        className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all ${listen.st === 'ready' ? 'bg-zinc-800 text-white' : 'border border-zinc-200 text-zinc-500 hover:bg-zinc-50'} disabled:opacity-50`}
                    >
                        <svg className={`w-3.5 h-3.5 ${listen.st === 'busy' ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                        </svg>
                        {listen.st === 'ready' ? '播放中' : listen.st === 'busy' ? '合成中' : '听本章'}
                    </button>
                    <span className="ml-auto flex items-center gap-1 flex-shrink-0">
                        <ChapterNavButton dir="prev" disabled={!prev} title={prev?.title} onClick={() => prev && onSelectChapter?.(prev)} />
                        <span className="text-[11px] text-zinc-300 tabular-nums px-1">
                            {chapterIdx >= 0 ? `${chapterIdx + 1}/${chapters.length}` : ''}
                        </span>
                        <ChapterNavButton dir="next" disabled={!next} title={next?.title} onClick={() => next && onSelectChapter?.(next)} />
                    </span>
                </div>
                {listen.st !== 'idle' && (
                    <div className="mt-2.5 min-w-0" data-listen-bar>
                        {listen.st === 'ready' ? (
                            <audio controls autoPlay preload="metadata" src={listen.url} className="w-full h-9" data-audio-player />
                        ) : (
                            <p className={`text-[11px] ${listen.st === 'err' ? 'text-red-400' : 'text-zinc-400'}`} data-listen-status>
                                {listen.st === 'busy' ? `${listen.msg}……（整章约需几十秒到几分钟，可继续翻页阅读）` : `${listen.msg}，再点一次「听本章」重试`}
                            </p>
                        )}
                    </div>
                )}
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
                {/* 摘要条：全宽（不随双栏断开） */}
                {(summaryLoading || summary) && (
                    <div className="px-6 pt-4">
                        <div className="bg-zinc-50/80 border border-zinc-100 rounded-xl">
                            <button
                                onClick={() => setSummaryOpen(o => !o)}
                                className="w-full flex items-center gap-2 px-4 py-2"
                            >
                                <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">本章摘要</span>
                                {!summaryLoading && (
                                    <svg className={`w-3.5 h-3.5 text-zinc-300 transition-transform ${summaryOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                )}
                            </button>
                            {summaryOpen && (
                                <div className="px-4 pb-3">
                                    {summaryLoading ? (
                                        <div className="flex items-center gap-2 text-zinc-300 text-xs py-1">
                                            <div className="animate-spin h-3.5 w-3.5 border-2 border-zinc-200 border-t-transparent rounded-full"></div>
                                            摘要生成中
                                        </div>
                                    ) : (
                                        <>
                                            <p className="text-[13px] text-zinc-600 leading-relaxed">{summary.summary}</p>
                                            {summary.keywords?.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {summary.keywords.map((kw, i) => (
                                                        <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-white text-zinc-400 border border-zinc-200">{kw}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* 正文 */}
                <div className="px-6 py-5">
                    {currentChapter ? (
                        currentChapter.content ? (
                            <div ref={setColBoxEl}>
                                <div className={twoCol ? 'book-columns' : ''}>
                                    <ChapterParagraphs text={currentChapter.content} />
                                </div>
                            </div>
                        ) : currentChapter.loadError ? (
                            <p className="text-zinc-300 text-sm py-8 text-center">本章内容缺失</p>
                        ) : (
                            <p className="text-zinc-300 text-sm py-8 text-center">章节加载中…</p>
                        )
                    ) : (
                        <div className="text-center text-zinc-300 text-sm py-16">
                            {currentBook.total_chapters ? '从顶栏「目录」选择一章开始' : '该书暂无章节'}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default ReadingPane;
