import { useState, useEffect, useRef } from 'react';
import { loadAppearance, PAPER_THEMES } from '../appearance.js';

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

// —— v2.7 划线高亮辅助 ——
// 渲染文本会经过 trim/清洗，与选区文本比对统一去掉全部空白再匹配（偏移映射回原文）
const normWs = s => (s || '').replace(/\s+/g, '');

// 计算选区端点 (node, offset) 在 root 纯文本中的偏移（跨 mark 等子节点也准）
function textOffsetIn(root, node, offset) {
    let acc = 0;
    let found = false;
    const walk = (n) => {
        if (found) return;
        if (n === node) {
            if (n.nodeType === 3) {
                acc += offset;
            } else {
                for (let i = 0; i < offset && i < n.childNodes.length; i++) {
                    acc += (n.childNodes[i].textContent || '').length;
                }
            }
            found = true;
            return;
        }
        if (n.nodeType === 3) { acc += n.length; return; }
        for (const c of n.childNodes) { if (found) return; walk(c); }
    };
    if (root.contains(node)) walk(root);
    return found ? acc : -1;
}

// 把 raw 渲染串中命中的划线片段包成 <mark data-hl>；去空白匹配、匹配不到优雅跳过
function wrapHighlights(raw, hls) {
    if (!raw || !hls || hls.length === 0) return raw;
    const chars = [];
    const idx = [];
    for (let i = 0; i < raw.length; i++) {
        if (!/\s/.test(raw[i])) { chars.push(raw[i]); idx.push(i); }
    }
    const hay = chars.join('');
    if (!hay) return raw;
    const spans = [];
    for (const h of hls) {
        const needle = normWs(h.text);
        if (!needle) continue;
        const at = hay.indexOf(needle);
        if (at === -1) continue;   // 书重切/文本改版：匹配不到就跳过，绝不错位包半截
        spans.push([idx[at], idx[at + needle.length - 1] + 1, h]);
    }
    if (spans.length === 0) return raw;
    spans.sort((a, b) => a[0] - b[0]);
    const out = [];
    let cur = 0;
    for (const [s, e, h] of spans) {
        if (s < cur) continue;     // 重叠片段只保留先匹配的
        if (s > cur) out.push(raw.slice(cur, s));
        out.push(<mark key={h.highlight_id} className="hl-mark" data-hl={h.highlight_id}>{raw.slice(s, e)}</mark>);
        cur = e;
    }
    if (cur < raw.length) out.push(raw.slice(cur));
    return out;
}

function ChapterParagraphs({ text, hlsByP }) {
    const cleaned = cleanChapterContent(text);
    let blocks = cleaned.split(/\n\n+/).filter(p => p.trim());
    // PDF 提取的书普遍没有空行（每个单换行就是一段）：此时整章会被并成一个巨型 block，
    // 而 CSS columns 无法在 break-inside-avoid 的块内分栏 → 双栏右列全空。退化为按行切段。
    if (blocks.length === 1 && blocks[0].includes('\n')) {
        blocks = blocks[0].split('\n').filter(b => b.trim());
    }
    const hlOf = i => (hlsByP && hlsByP[i]) || [];
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
                            <p className="text-lg font-serif-heading font-bold text-zinc-900 dark:text-zinc-100 reader-heading mb-2" style={{ breakAfter: 'avoid' }}>{wrapHighlights(firstLine, hlOf(i))}</p>
                            {bodyLines.map((l, j) => (
                                <p key={j} className="text-[15px] text-zinc-700 dark:text-zinc-200 leading-8 mb-2" style={{ textIndent: '2em' }}>{wrapHighlights(l.trim(), hlOf(i))}</p>
                            ))}
                        </div>
                    );
                }
                return (
                    <p key={i} data-p={i} className={`text-[15px] text-zinc-700 dark:text-zinc-200 leading-8 mb-3 ${avoid}`} style={{ textIndent: '2em' }}>
                        {wrapHighlights(block.trim(), hlOf(i))}
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
            className="reader-navbtn p-1.5 rounded-lg text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
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
// v2.7 划线：highlights=当前书全部划线；onAddHighlights(frags)/onRemoveHighlight(id)/onQuoteToChat({text,chapter_id,...})
function ReadingPane({ currentBook, currentChapter, onSelectChapter, citeTarget,
                       highlights, onAddHighlights, onRemoveHighlight, onQuoteToChat }) {
    const [summary, setSummary] = useState(null);
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [summaryOpen, setSummaryOpen] = useState(true);
    const [selBar, setSelBar] = useState(null);   // 选区操作条 {top,left,frags,text}
    const [hlMenu, setHlMenu] = useState(null);   // 点已划线弹层 {top,left,id}
    const [hlBusy, setHlBusy] = useState(false);
    // v3.5 外观：纸张/字号即时响应设置面板（'wb-appearance' 广播，不走 props 层层透传）
    const [ap, setAp] = useState(loadAppearance);
    useEffect(() => {
        const h = () => setAp(loadAppearance());
        window.addEventListener('wb-appearance', h);
        return () => window.removeEventListener('wb-appearance', h);
    }, []);
    const paper = PAPER_THEMES[ap.paper] || PAPER_THEMES.white;
    const rootRef = useRef(null);
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

    // 滚动时收起浮层（选区条/划线菜单是视口定位，滚动后位置会失真）。
    // 依赖恒空：ref 在挂载 effect 前已就位，若依赖 scrollRef.current 则值变化不会触发重跑（永不挂载）
    useEffect(() => {
        const box = scrollRef.current;
        if (!box) return;
        const hide = () => { setSelBar(null); setHlMenu(null); };
        box.addEventListener('scroll', hide, { passive: true });
        return () => box.removeEventListener('scroll', hide);
    }, []);

    // 把当前选区拆成「逐渲染叶子 <p> 的片段」：锚点 = 所属块索引(data-p) + 片段原文。
    // 不用字符偏移——cleanChapterContent 会改写文本，偏移必然对不上（设计依据见 highlight_store 注释）
    const collectSelection = () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        const range = sel.getRangeAt(0);
        const raw = sel.toString().trim();
        const box = scrollRef.current;
        if (!raw || !box || !box.contains(range.commonAncestorContainer)) return null;
        const frags = [];
        for (const leaf of box.querySelectorAll('p[data-p], [data-p] p')) {
            if (!range.intersectsNode(leaf)) continue;
            const full = leaf.textContent || '';
            if (!full.trim()) continue;
            let s = 0, e = full.length;
            if (leaf.contains(range.startContainer)) {
                const o = textOffsetIn(leaf, range.startContainer, range.startOffset);
                if (o > s) s = Math.min(o, full.length);
            }
            if (leaf.contains(range.endContainer)) {
                const o = textOffsetIn(leaf, range.endContainer, range.endOffset);
                if (o >= 0 && o < e) e = o;
            }
            const frag = full.slice(s, e).trim();
            if (!frag) continue;
            const block = leaf.closest('[data-p]');
            frags.push({ p: Number(block ? block.dataset.p : 0), text: frag });
        }
        return frags.length ? { frags, text: raw } : null;
    };

    const handleMouseUp = () => {
        if (hlBusy) return;
        setHlMenu(null);
        const got = collectSelection();
        if (!got) { setSelBar(null); return; }
        const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
        const rr = rootRef.current && rootRef.current.getBoundingClientRect();
        if (!rr) return;
        setSelBar({
            top: Math.max(6, rect.top - rr.top - 40),
            left: Math.max(8, Math.min(rect.left - rr.left + rect.width / 2 - 95, rr.width - 198)),
            ...got,
        });
    };

    const doHighlight = async () => {
        if (!selBar || !currentBook || !currentChapter || hlBusy) return;
        setHlBusy(true);
        try {
            await onAddHighlights?.(selBar.frags.map(f => ({ start_p: f.p, text: f.text })));
            window.getSelection()?.removeAllRanges();
            setSelBar(null);
        } finally {
            setHlBusy(false);
        }
    };

    const doQuoteToChat = () => {
        if (!selBar || !currentChapter) return;
        onQuoteToChat?.({
            text: selBar.text,
            chapter_id: currentChapter.chapter_id,
            chapter_title: currentChapter.title,
        });
        window.getSelection()?.removeAllRanges();
        setSelBar(null);
    };

    const doCopy = () => {
        if (!selBar) return;
        try { navigator.clipboard?.writeText(selBar.text); } catch { /* 非安全上下文静默 */ }
        setSelBar(null);
    };

    const handleBodyClick = (e) => {
        if (e.target.closest?.('[data-sel-bar],[data-hl-menu]')) return;
        const mark = e.target.closest?.('[data-hl]');
        if (!mark) { setHlMenu(null); return; }
        const rr = rootRef.current && rootRef.current.getBoundingClientRect();
        const rect = mark.getBoundingClientRect();
        if (!rr) return;
        setSelBar(null);
        setHlMenu({
            id: mark.dataset.hl,
            top: Math.min(rect.bottom - rr.top + 6, rr.height - 52),
            left: Math.max(8, Math.min(rect.left - rr.left, rr.width - 118)),
        });
    };

    // 本章划线按块索引分组，供 ChapterParagraphs 逐段匹配渲染
    const hlsByP = {};
    for (const h of (highlights || [])) {
        if (h.chapter_id !== currentChapter?.chapter_id) continue;
        (hlsByP[h.start_p] = hlsByP[h.start_p] || []).push(h);
    }

    if (!currentBook) {
        return (
            <div className="flex-1 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 flex items-center justify-center min-w-0">
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
        <div ref={rootRef} onClick={handleBodyClick} data-paper={ap.paper}
             className="reader-surface relative flex-1 min-w-0 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col overflow-hidden"
             style={{ backgroundColor: paper.bg, borderColor: paper.border,
                      '--paper-fg': paper.fg, '--paper-strong': paper.strong, '--paper-muted': paper.muted,
                      '--paper-panel': paper.panel, '--paper-border': paper.border, '--reader-fs': `${ap.fontSize}px` }}>
            {/* 章头：标题 + 字数 + 翻页 */}
            <div className="px-6 pt-4 pb-3 border-b border-zinc-100 dark:border-zinc-800 reader-panel flex-shrink-0" style={{ borderWidth: '0 0 1px' }}>
                <div className="flex items-center gap-3 min-w-0">
                    <h2 className="text-base font-serif-heading font-semibold text-zinc-900 dark:text-zinc-100 reader-title truncate">
                        {currentChapter?.title || ''}
                    </h2>
                    {currentChapter?.word_count ? (
                        <span className="text-[11px] text-zinc-300 reader-muted flex-shrink-0 tabular-nums">{currentChapter.word_count} 字</span>
                    ) : null}
                    <button
                        onClick={startListen}
                        disabled={!currentChapter || listen.st === 'busy'}
                        title="听本章"
                        data-listen-chapter
                        className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all ${listen.st === 'ready' ? 'bg-zinc-800 dark:bg-zinc-700 text-white' : 'border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'} disabled:opacity-50`}
                    >
                        <svg className={`w-3.5 h-3.5 ${listen.st === 'busy' ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                        </svg>
                        {listen.st === 'ready' ? '播放中' : listen.st === 'busy' ? '合成中' : '听本章'}
                    </button>
                    <span className="ml-auto flex items-center gap-1 flex-shrink-0">
                        <ChapterNavButton dir="prev" disabled={!prev} title={prev?.title} onClick={() => prev && onSelectChapter?.(prev)} />
                        <span className="text-[11px] text-zinc-300 reader-muted tabular-nums px-1">
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
                            <p className={`text-[11px] ${listen.st === 'err' ? 'text-red-400' : 'text-zinc-400 dark:text-zinc-500'}`} data-listen-status>
                                {listen.st === 'busy' ? `${listen.msg}……（整章约需几十秒到几分钟，可继续翻页阅读）` : `${listen.msg}，再点一次「听本章」重试`}
                            </p>
                        )}
                    </div>
                )}
            </div>

            <div ref={scrollRef} onMouseUp={handleMouseUp} className="flex-1 overflow-y-auto scrollbar-thin">
                {/* 摘要条：全宽（不随双栏断开） */}
                {(summaryLoading || summary) && (
                    <div className="px-6 pt-4">
                        <div className="reader-panel bg-zinc-50/80 dark:bg-zinc-900/70 border border-zinc-100 dark:border-zinc-800 rounded-xl">
                            <button
                                onClick={() => setSummaryOpen(o => !o)}
                                className="w-full flex items-center gap-2 px-4 py-2"
                            >
                                <span className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 reader-muted uppercase tracking-wider">本章摘要</span>
                                {!summaryLoading && (
                                    <svg className={`w-3.5 h-3.5 text-zinc-300 transition-transform ${summaryOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                )}
                            </button>
                            {summaryOpen && (
                                <div className="px-4 pb-3">
                                    {summaryLoading ? (
                                        <div className="flex items-center gap-2 text-zinc-300 reader-muted text-xs py-1">
                                            <div className="animate-spin h-3.5 w-3.5 border-2 border-zinc-200 dark:border-zinc-800 border-t-transparent rounded-full"></div>
                                            摘要生成中
                                        </div>
                                    ) : (
                                        <>
                                            <p className="text-[13px] text-zinc-600 dark:text-zinc-300 reader-fg leading-relaxed">{summary.summary}</p>
                                            {summary.keywords?.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {summary.keywords.map((kw, i) => (
                                                        <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 border border-zinc-200 dark:border-zinc-800">{kw}</span>
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
                            <div ref={setColBoxEl} className="reader-body">
                                <div className={twoCol ? 'book-columns' : ''}>
                                    <ChapterParagraphs text={currentChapter.content} hlsByP={hlsByP} />
                                </div>
                            </div>
                        ) : currentChapter.loadError ? (
                            <p className="text-zinc-300 reader-muted text-sm py-8 text-center">本章内容缺失</p>
                        ) : (
                            <p className="text-zinc-300 reader-muted text-sm py-8 text-center">章节加载中…</p>
                        )
                    ) : (
                        <div className="text-center text-zinc-300 reader-muted text-sm py-16">
                            {currentBook.total_chapters ? '从顶栏「目录」选择一章开始' : '该书暂无章节'}
                        </div>
                    )}
                </div>
            </div>

            {/* v2.7 选区操作条：划线 / 加入对话 / 复制 */}
            {selBar && (
                <div data-sel-bar
                     className="absolute z-30 flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-zinc-900 shadow-xl animate-fade-in"
                     style={{ top: selBar.top, left: selBar.left }}
                     onMouseUp={e => e.stopPropagation()}>
                    <button onMouseDown={e => e.preventDefault()} onClick={doHighlight} disabled={hlBusy}
                            data-sel-hl className="px-2 py-1 rounded-md text-[12px] text-amber-300 hover:bg-zinc-700 disabled:opacity-50">划线</button>
                    <button onMouseDown={e => e.preventDefault()} onClick={doQuoteToChat}
                            data-sel-quote className="px-2 py-1 rounded-md text-[12px] text-sky-300 hover:bg-zinc-700">加入对话</button>
                    <button onMouseDown={e => e.preventDefault()} onClick={doCopy}
                            data-sel-copy className="px-2 py-1 rounded-md text-[12px] text-zinc-300 hover:bg-zinc-700">复制</button>
                </div>
            )}

            {/* 点已有划线弹层：取消划线 / 加入对话 */}
            {hlMenu && (
                <div data-hl-menu
                     className="absolute z-30 flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-zinc-900 shadow-xl animate-fade-in"
                     style={{ top: hlMenu.top, left: hlMenu.left }}
                     onMouseUp={e => e.stopPropagation()}>
                    <button onMouseDown={e => e.preventDefault()}
                            onClick={async () => { await onRemoveHighlight?.(hlMenu.id); setHlMenu(null); }}
                            data-hl-remove className="px-2 py-1 rounded-md text-[12px] text-red-300 hover:bg-zinc-700">取消划线</button>
                    <button onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                                const h = (highlights || []).find(x => x.highlight_id === hlMenu.id);
                                if (h) onQuoteToChat?.({ text: h.text, chapter_id: h.chapter_id, chapter_title: h.chapter_title });
                                setHlMenu(null);
                            }}
                            data-hl-quote className="px-2 py-1 rounded-md text-[12px] text-sky-300 hover:bg-zinc-700">加入对话</button>
                </div>
            )}
        </div>
    );
}

export default ReadingPane;
