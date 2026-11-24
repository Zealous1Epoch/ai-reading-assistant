import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = '';

// 逐题引导浮层（v3.4）：「读书十问」「导读」一题一停
// kind='questions' 硬门禁：答过题 → 「小结本题」出小结 → 「下一题」才亮（后端 can_advance 同口径双保险）
// kind='lead' 软模式：预读题逐条翻，答不答自愿；核心概述全部走完才揭示（后端接口层已剥剧透）
// 断点续跑：挂载先查同范围 in_progress 会话，有就接着答，没有才出卷（SSE status→artifact）
export default function GuideOverlay({ kind, book, chapter, onBack }) {
    const isStrict = kind === 'questions';
    const [guide, setGuide] = useState(undefined);   // undefined=找/生成中, null=失败
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [draft, setDraft] = useState('');
    const [live, setLive] = useState('');            // 正在流的教练讲评/小结/收束
    const [streaming, setStreaming] = useState(false);
    const [closing, setClosing] = useState('');
    const [overview, setOverview] = useState('');
    const threadRef = useRef(null);
    const deadRef = useRef(false);
    useEffect(() => () => { deadRef.current = true; }, []);

    const refresh = useCallback(async (gid) => {
        const r = await fetch(`${API_BASE}/guides/${gid}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!deadRef.current) setGuide(d.guide);
    }, []);

    // SSE：消费 data: 帧；content 进 live，artifact 落 guide，error 落错
    const consumeSSE = async (res, onContent) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let art = null;
        let err = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const p = line.slice(6);
                if (p === '[DONE]') continue;
                try {
                    const f = JSON.parse(p);
                    if (f.status !== undefined) setStatus(f.status);
                    else if (f.content !== undefined) onContent(f.content);
                    else if (f.artifact) art = f.artifact;
                    else if (f.error) err = f.error;
                } catch { /* 半截帧丢弃 */ }
            }
        }
        if (err) throw new Error(err);
        return art;
    };

    const startFresh = useCallback(async () => {
        setStatus(isStrict ? '出题中：改造只属于这本书的十道考题…' : '导读单生成中…');
        setError('');
        try {
            const path = isStrict ? '/guides/questions/start' : '/guides/lead/start';
            const res = await fetch(`${API_BASE}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ book_id: book.book_id, chapter_id: chapter?.chapter_id || null }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `启动失败 (${res.status})`);
            const art = await consumeSSE(res, () => {});
            if (art?.type === 'guide') setGuide(art.data);
            else throw new Error('题单生成失败，请重试');
        } catch (e) {
            setError(e.message);
            setGuide(null);
        }
    }, [book.book_id, chapter?.chapter_id, isStrict]);

    // 挂载：找同范围可续会话，没有就出新卷
    useEffect(() => {
        let dead = false;
        (async () => {
            try {
                const r = await fetch(`${API_BASE}/guides?book_id=${encodeURIComponent(book.book_id)}&status=in_progress`);
                const d = await r.json();
                const same = (d.guides || []).find(g => g.kind === kind
                    && (g.chapter_id || '') === (chapter?.chapter_id || ''));
                if (!dead) {
                    if (same) { setGuide(same); setStatus(''); }
                    else startFresh();
                }
            } catch { if (!dead) startFresh(); }
        })();
        return () => { dead = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [book.book_id, chapter?.chapter_id, kind]);

    const idx = guide ? guide.current_index : 0;
    const total = guide ? (guide.questions || []).length : 0;
    const finished = !!guide && idx >= total;
    const perQ = guide && !finished ? (guide.per_q || [])[idx] || { turns: [], resolved: false } : { turns: [], resolved: false };
    const hasReaderTurn = perQ.turns.some(t => t.role === 'reader');

    useEffect(() => {
        const el = threadRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [perQ.turns.length, live, idx]);

    // —— 动作 ——
    const send = async () => {
        const text = draft.trim();
        if (!text || !guide || streaming) return;
        setDraft('');
        setStreaming(true);
        setLive('');
        setGuide(g => ({ ...g, per_q: g.per_q.map((q, i) => i !== idx ? q : { ...q, turns: [...q.turns, { role: 'reader', text }] }) }));
        try {
            const res = await fetch(`${API_BASE}/guides/${guide.guide_id}/reply`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q_index: idx, text }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `提交失败 (${res.status})`);
            await consumeSSE(res, c => setLive(s => s + c));
        } catch (e) { setError(e.message); }
        setLive('');
        setStreaming(false);
        await refresh(guide.guide_id);
    };

    const doSummarize = async () => {
        if (!guide || streaming) return;
        setStreaming(true); setLive(''); setError('');
        try {
            const res = await fetch(`${API_BASE}/guides/${guide.guide_id}/summarize`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q_index: idx }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `生成失败 (${res.status})`);
            await consumeSSE(res, c => setLive(s => s + c));
        } catch (e) { setError(e.message); }
        setLive('');
        setStreaming(false);
        await refresh(guide.guide_id);
    };

    const next = async () => {
        if (!guide) return;
        setError('');
        try {
            const res = await fetch(`${API_BASE}/guides/${guide.guide_id}/advance`, { method: 'POST' });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `推进失败 (${res.status})`);
            const d = await res.json();
            setGuide(d.guide);
            setDraft('');
        } catch (e) { setError(e.message); }
    };

    const restart = async () => {
        if (guide) { try { await fetch(`${API_BASE}/guides/${guide.guide_id}`, { method: 'DELETE' }); } catch { /* 删不掉也重开 */ } }
        setGuide(undefined); setClosing(''); setOverview('');
        await startFresh();
    };

    const reveal = async () => {
        setStreaming(true);
        try {
            const res = await fetch(`${API_BASE}/guides/${guide.guide_id}/overview`, { method: 'POST' });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || '揭示失败');
            const d = await res.json();
            setOverview(d.overview);
            if (d.guide) setGuide(d.guide);
        } catch (e) { setError(e.message); }
        setStreaming(false);
    };

    const showClosing = async () => {
        setStreaming(true); setClosing(''); setError('');
        try {
            const res = await fetch(`${API_BASE}/guides/${guide.guide_id}/closing`, { method: 'POST' });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || '生成失败');
            await consumeSSE(res, c => setClosing(s => s + c));
        } catch (e) { setError(e.message); }
        setStreaming(false);
    };

    // —— 渲染 ——
    const Bubble = ({ role, text }) => (
        <div className={`flex ${role === 'reader' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                role === 'reader' ? 'bg-zinc-800 text-white' : role === 'summary' ? 'bg-amber-50 border border-amber-200 text-zinc-800' : 'bg-white border border-zinc-200 text-zinc-700'
            }`}>
                {role === 'summary' && <span className="block text-[11px] font-semibold text-amber-600 mb-1">本题小结</span>}
                {role === 'coach' && <span className="block text-[11px] font-semibold text-zinc-400 mb-1">教练</span>}
                {text}
            </div>
        </div>
    );

    const q = guide && !finished ? (guide.questions || [])[idx] : null;
    const canNext = guide && !streaming && (isStrict ? perQ.resolved : true);
    const progress = total ? Math.min(idx, total) / total : 0;

    return (
        <div data-guide-overlay className="fixed inset-0 z-50 bg-zinc-50 flex flex-col">
            {/* 顶栏 */}
            <div className="h-12 px-4 flex items-center gap-3 border-b border-zinc-200 bg-white flex-shrink-0">
                <button onClick={onBack} title="关闭" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-all">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    返回书页
                </button>
                <div className="h-4 w-px bg-zinc-200"></div>
                <h1 className="text-sm font-serif-heading font-semibold text-zinc-800 truncate">{guide?.title || (isStrict ? '读书十问' : '导读')}</h1>
                {guide && !finished && (
                    <span data-guide-progress className="text-[11px] text-zinc-400 tabular-nums flex-shrink-0">
                        第 {idx + 1} / {total} 题
                    </span>
                )}
                {finished && <span className="text-[11px] text-emerald-500 flex-shrink-0">已走完</span>}
                <div className="flex-1"></div>
                {guide && (
                    <button onClick={restart} className="px-2.5 py-1.5 rounded-lg text-[11px] text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all flex-shrink-0">
                        {isStrict ? '重新出卷' : '重新生成'}
                    </button>
                )}
            </div>
            {/* 进度条 */}
            <div className="h-0.5 bg-zinc-100 flex-shrink-0">
                <div className="h-full bg-zinc-700 transition-all duration-300" style={{ width: `${progress * 100}%` }}></div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
                <div className="max-w-2xl mx-auto space-y-4">
                    {!guide && error && (
                        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center">
                            <p className="text-sm text-red-600 mb-3">{error}</p>
                            <button onClick={restart} className="px-4 py-1.5 bg-zinc-800 text-white rounded-full text-xs hover:bg-zinc-900">重试</button>
                        </div>
                    )}
                    {!guide && !error && (
                        <div className="py-20 text-center">
                            <div className="text-sm text-zinc-400 animate-pulse">{status || '准备中…'}</div>
                            <div className="text-[11px] text-zinc-300 mt-2">题单只出一次，之后一题一停</div>
                        </div>
                    )}

                    {guide && !finished && q && (
                        <>
                            {/* 题面 */}
                            <div data-guide-question className="rounded-2xl border border-zinc-200 bg-white px-5 py-4">
                                <div className="text-[11px] font-semibold text-zinc-300 mb-1.5">第 {idx + 1} 题{isStrict ? '' : ' · 预读导问'}</div>
                                <p className="text-[15px] leading-relaxed text-zinc-800">{q.q}</p>
                                {q.pointer && <p className="text-[12px] text-zinc-400 mt-2">（去《{q.pointer}》找线索）</p>}
                            </div>

                            {/* 本题对话 */}
                            <div ref={threadRef} className="space-y-2.5 max-h-[38vh] overflow-y-auto scrollbar-thin px-0.5">
                                {perQ.turns.length === 0 && !live && (
                                    <p className="text-center text-[12px] text-zinc-300 py-4">
                                        {isStrict ? '先写下你的答案——不完整也写，教练会针对你的回答追问' : '可先去读原文，也可直接把你的猜想发给教练；想过就翻下一题'}
                                    </p>
                                )}
                                {perQ.turns.map((t, i) => <Bubble key={i} role={t.role} text={t.text} />)}
                                {perQ.summary && <Bubble role="summary" text={perQ.summary} />}
                                {live && <Bubble role="coach" text={live} />}
                            </div>

                            {error && <p className="text-[12px] text-red-500 text-center">{error}</p>}

                            {/* 作答区 */}
                            <div className="space-y-2">
                                <textarea
                                    data-guide-answer
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    rows={3}
                                    placeholder={isStrict ? '你的答案（哪怕只有方向）…' : '想法 / 猜想（可不填，直接下一题）…'}
                                    className="w-full px-3.5 py-2.5 bg-white border border-zinc-200 rounded-xl text-[13px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-300 resize-none"
                                />
                                <div className="flex items-center gap-2">
                                    <button
                                        data-guide-send
                                        onClick={send}
                                        disabled={!draft.trim() || streaming}
                                        className="px-4 py-1.5 bg-zinc-800 text-white rounded-full text-xs font-medium hover:bg-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                    >
                                        发送答案
                                    </button>
                                    <button
                                        data-guide-summarize
                                        onClick={doSummarize}
                                        disabled={!hasReaderTurn || streaming || perQ.resolved}
                                        title={!hasReaderTurn ? '先作答' : undefined}
                                        className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-all ${perQ.resolved ? 'text-amber-600 border-amber-200 bg-amber-50' : 'text-zinc-600 border-zinc-300 bg-white hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed'}`}
                                    >
                                        {perQ.resolved ? '本题小结已出' : isStrict ? '想通了，出小结' : '帮我小结本题'}
                                    </button>
                                    <button
                                        data-guide-next
                                        onClick={next}
                                        disabled={!canNext}
                                        title={isStrict && !perQ.resolved ? '读书十问：出完本题小结才能进下一题' : undefined}
                                        className="ml-auto px-4 py-1.5 bg-zinc-800 text-white rounded-full text-xs font-medium hover:bg-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0"
                                    >
                                        下一题 →
                                    </button>
                                </div>
                                {isStrict && !perQ.resolved && hasReaderTurn && (
                                    <p className="text-[11px] text-zinc-300">这一题讨论清楚后点「想通了，出小结」，小结出来才能进下一题——这就是不跳题的规矩。</p>
                                )}
                            </div>
                        </>
                    )}

                    {/* 收束页 */}
                    {guide && finished && (
                        <div className="space-y-4">
                            {isStrict ? (
                                <div className="rounded-2xl border border-zinc-200 bg-white px-5 py-5" data-guide-closing>
                                    <h2 className="text-sm font-semibold text-zinc-800 mb-1">收束：这一场十问</h2>
                                    <p className="text-[12px] text-zinc-400 mb-3">基于全程问答的诚实清单——想通了什么、哪里还没啃动。</p>
                                    {closing || guide.closing ? (
                                        <p className="text-[13px] leading-relaxed text-zinc-700 whitespace-pre-wrap">{closing || guide.closing}</p>
                                    ) : (
                                        <button onClick={showClosing} disabled={streaming}
                                            className="px-4 py-1.5 bg-zinc-800 text-white rounded-full text-xs font-medium hover:bg-zinc-900 disabled:opacity-40">
                                            生成收束清单
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-zinc-200 bg-white px-5 py-5" data-guide-closing>
                                    <h2 className="text-sm font-semibold text-zinc-800 mb-1">读后对答案</h2>
                                    {(guide.check || []).length > 0 && (
                                        <div className="mb-4">
                                            <div className="text-[11px] font-semibold text-zinc-300 mb-1.5">自查清单（合上书自验）</div>
                                            <ul className="space-y-1.5">
                                                {(guide.check || []).map((c, i) => (
                                                    <li key={i} className="text-[13px] text-zinc-600 leading-relaxed">□ {c}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    {overview || guide.overview ? (
                                        <div>
                                            <div className="text-[11px] font-semibold text-zinc-300 mb-1.5">核心概述</div>
                                            <p className="text-[13px] leading-relaxed text-zinc-700 whitespace-pre-wrap">{overview || guide.overview}</p>
                                        </div>
                                    ) : (
                                        <button onClick={reveal} disabled={streaming}
                                            className="px-4 py-1.5 bg-zinc-800 text-white rounded-full text-xs font-medium hover:bg-zinc-900 disabled:opacity-40">
                                            我已读完，揭示核心概述
                                        </button>
                                    )}
                                </div>
                            )}
                            {error && <p className="text-[12px] text-red-500 text-center">{error}</p>}
                            <div className="text-center">
                                <button onClick={onBack} className="px-5 py-2 rounded-full border border-zinc-300 text-xs text-zinc-500 hover:bg-white transition-all">
                                    回到书页
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
