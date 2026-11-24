import { useState, useEffect, useRef, useMemo } from 'react';
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

// ---------- 思维导图 JSON → markmap 画布（v2.9：借鉴 markmap 渲染，保留跳原文/按需展开/全屏） ----------
export function parseMindmapJson(raw) {
    const t = (raw || '').trim();
    if (!t.startsWith('{')) return null;
    try {
        const o = JSON.parse(t);
        return (o && typeof o.t === 'string') ? o : null;
    } catch { return null; }
}

// Markdown 转义：标题文本可能含 * _ [ ] ` 等，防止被 remark 解析成强调/链接；<> 转实体防误触 HTML
const mmEscape = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\\`*_~[\]()#|]/g, (c) => '\\' + c);

// JSON 树 → Markdown（根=标题，子孙=嵌套列表项）。章节点嵌 <a data-mm-jump> 跳原文；
// 深层分支不设独立按钮：点章节点的折叠圆圈即现场调大模型生成（handleCanvasClick 圆圈委托），
// 生成中显示 ⏳，失败显示 ⚠（再点圆圈重试）；markmap 节点支持内联 HTML，点击由外层容器事件委托接回 React
function mmNodeToMd(node, depth, ctx) {
    let label = mmEscape(node.t);
    if (node.cid) label = `<a data-mm-jump="${node.cid}">${label}</a>`;
    const loaded = node.cid ? ctx.subtrees[node.cid] : null;
    let extra = '';
    if (node.cid && !loaded && depth > 0) {
        if (ctx.loadingCid === node.cid) extra = ` <span data-mm-loading="${node.cid}">⏳生成中…</span>`;
        else if (ctx.errors[node.cid]) extra = ` <span data-mm-error="${node.cid}" title="${mmEscape(ctx.errors[node.cid])}">⚠生成失败，点圆圈重试</span>`;
    }
    let line;
    if (depth === 0) line = `# ${label}${extra}`;
    else line = `${'  '.repeat(depth - 1)}- ${label}${extra}`;
    const children = (loaded && loaded.c) || node.c || [];
    for (const c of children) line += '\n' + mmNodeToMd(c, depth + 1, ctx);
    return line;
}

const mmFindNodeByCid = (node, cid) => {
    if (node.cid === cid) return node;
    for (const c of (node.c || [])) {
        const hit = mmFindNodeByCid(c, cid);
        if (hit) return hit;
    }
    return null;
};

// 在 markmap 活树（mm.state.data，setData 时会克隆节点）里按 cid 找真实节点——折叠态 payload 必须挂在活树上
const mmFindLiveByCid = (node, cid) => {
    if (!node) return null;
    if (String(node.content || '').includes(`data-mm-jump="${cid}"`)) return node;
    for (const c of (node.children || [])) {
        const hit = mmFindLiveByCid(c, cid);
        if (hit) return hit;
    }
    return null;
};
// 递归解除折叠（payload.fold=0）：详分支生成完 setData 后该章会回落到折叠基线，用它现场全展开
const mmUnfoldAll = (node) => {
    node.payload = { ...node.payload, fold: 0 };
    for (const c of (node.children || [])) mmUnfoldAll(c);
};

// 一级分支按色相轮转着色（colorFreeze 效果：path 以 . 分隔且含祖先 id，seg[1]=所属一级分支 id，同章同色），根 zinc-900
const mmHueColor = (n) => {
    const seg = String((n && n.state && n.state.path) || '').split('.').filter(Boolean);
    if (seg.length <= 1) return '#18181b';
    const idx = Number(seg[1]) || 0;
    return `hsl(${(idx * 47) % 360}, 42%, 45%)`;
};

const mmTransformer = new Transformer();

export function MindmapTree({ root, bookId, onNavigateToSource, height = 400 }) {
    const [subtrees, setSubtrees] = useState({});   // cid → 按需展开的深层子树
    const [loadingCid, setLoadingCid] = useState(null);
    const [expandErrors, setExpandErrors] = useState({});
    const [fullscreen, setFullscreen] = useState(false);
    // 展开层级基线：1=到章 2=到主题 Infinity=全部 → markmap initialExpandLevel（折叠 depth>=该值；-1 全展开）
    const MM_LEVEL = { 1: 2, 2: 3 };
    const [level, setLevel] = useState(1);
    const [rebuildKey, setRebuildKey] = useState(0);
    const [ready, setReady] = useState(false);
    const svgRef = useRef(null);
    const mmRef = useRef(null);
    const autoOpenRef = useRef(null);   // 刚生成完详分支的章 cid：setData 渲染后自动全展开该章

    const md = useMemo(
        () => mmNodeToMd(root, 0, { subtrees, loadingCid, errors: expandErrors }),
        [root, subtrees, loadingCid, expandErrors]
    );

    // 渲染：rebuildKey/level 变 → 重建实例（手动折叠态回到基线）；仅 md 变 → setData 增量（保留手动折叠）
    useEffect(() => {
        if (!svgRef.current) return;
        const expandLevel = level === Infinity ? -1 : (MM_LEVEL[level] ?? 2);
        let mm = mmRef.current;
        if (mm && mm._mmExpandLevel !== expandLevel) { try { mm.destroy(); } catch { /* noop */ } mm = null; }
        if (!mm) {
            svgRef.current.innerHTML = '';
            mm = Markmap.create(svgRef.current, {
                maxWidth: 320,
                initialExpandLevel: expandLevel,
                color: mmHueColor,
                spacingHorizontal: 64,
                spacingVertical: 6,
                paddingX: 8,
            });
            mm._mmExpandLevel = expandLevel;
            mmRef.current = mm;
        }
        try {
            // markmap-lib 0.18：transform() 是同步 API，setData() 才是异步
            const { root: r } = mmTransformer.transform(md);
            mm.setData(r).then(async () => {
                // 刚生成完某章详分支：setData 会把折叠态打回基线，这里在活树上把该章递归展开再重绘
                const cid = autoOpenRef.current;
                autoOpenRef.current = null;
                if (cid && mm.state && mm.state.data) {
                    const live = mmFindLiveByCid(mm.state.data, cid);
                    if (live && live.children && live.children.length) {
                        mmUnfoldAll(live);
                        try { await mm.renderData(live); } catch { /* 重绘失败不阻断 */ }
                        mm.fit().catch(() => {});
                    }
                }
                setReady(true);
            }).catch(e => console.error('markmap setData 失败:', e));
        } catch (e) {
            console.error('markmap 渲染失败:', e);
        }
    }, [md, level, rebuildKey]);

    useEffect(() => () => { try { mmRef.current?.destroy(); } catch { /* 已销毁 */ } mmRef.current = null; }, []);

    // 全屏只是给同一容器换类名（实例不重建不闪），换完 fit 一次
    useEffect(() => {
        const timer = setTimeout(() => { mmRef.current?.fit().catch(() => {}); }, fullscreen ? 350 : 60);
        return () => clearTimeout(timer);
    }, [fullscreen]);

    // 按需展开：SSE 拿该章深层子树，成功后合入 subtrees 触发 setData
    const expandChapter = async (cid) => {
        if (!cid || loadingCid || subtrees[cid]) return;
        const node = mmFindNodeByCid(root, cid);
        if (!node) return;
        setLoadingCid(cid);
        setExpandErrors(prev => ({ ...prev, [cid]: null }));
        try {
            const res = await fetch('/api/tools/mindmap/expand/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ book_id: bookId, chapter_id: cid }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let subtree = null;
            let err = null;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6);
                    if (payload === '[DONE]') continue;
                    try {
                        const f = JSON.parse(payload);
                        if (f.artifact && f.artifact.data) subtree = JSON.parse(f.artifact.data);
                        else if (f.error) err = f.error;
                    } catch { /* 半截帧丢弃 */ }
                }
            }
            if (subtree) {
                autoOpenRef.current = cid;
                setSubtrees(prev => ({ ...prev, [cid]: subtree }));
            } else {
                setExpandErrors(prev => ({ ...prev, [cid]: err || '展开结果解析失败' }));
            }
        } catch (e) {
            setExpandErrors(prev => ({ ...prev, [cid]: `展开失败: ${e.message}` }));
        } finally {
            setLoadingCid(null);
        }
    };

    // 事件委托：节点内 HTML <a> 跳原文（foreignObject 内是 HTML，closest 可用）；
    // 点章节点的折叠圆圈＝首次现场生成该章详分支（d3 把 INode 绑在 circle.__data__ 上，content 里有跳转锚可反解 cid）。
    // 不拦冒泡——markmap 自己的圆圈处理照常折叠/展开
    const handleCanvasClick = (e) => {
        const jump = e.target.closest?.('[data-mm-jump]');
        if (jump) { onNavigateToSource?.(bookId, jump.getAttribute('data-mm-jump')); return; }
        const circle = e.target.closest?.('circle');
        if (circle) {
            const m = String(circle.__data__?.content || '').match(/data-mm-jump="([^"]+)"/);
            if (m) expandChapter(m[1]);
        }
    };

    // 导出：markmap 自带 embedGlobalCSS，样式在 svg 内，序列化即可独立打开
    const serializeSvg = () => {
        const svg = svgRef.current;
        if (!svg) return null;
        const clone = svg.cloneNode(true);
        const rect = svg.getBoundingClientRect();
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', Math.max(rect.width, 1));
        clone.setAttribute('height', Math.max(rect.height, 1));
        return new XMLSerializer().serializeToString(clone);
    };
    const download = (href, name) => {
        const a = document.createElement('a');
        a.href = href; a.download = name; a.click();
    };
    const filename = (root.t || '思维导图').replace(/[\\/:*?"<>|]/g, '_');
    const exportSvg = () => {
        const s = serializeSvg();
        if (!s) return;
        const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml;charset=utf-8' }));
        download(url, `${filename}.svg`);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    const exportPng = () => {
        const s = serializeSvg();
        if (!s) return;
        const rect = svgRef.current.getBoundingClientRect();
        const scale = 2;
        const img = new Image();
        // 必须用 data: URL —— Chrome 下 blob:/objectURL 的含 foreignObject SVG 绘入 canvas 会污染画布，toDataURL 抛 SecurityError
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = rect.width * scale; canvas.height = rect.height * scale;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                download(canvas.toDataURL('image/png'), `${filename}.png`);
            } catch (e) {
                console.error('PNG 导出失败，改用 SVG：', e);
                exportSvg();
            } finally { /* noop */ }
        };
        img.onerror = () => { console.error('PNG 导出失败，改用 SVG'); exportSvg(); };
        img.src = url;
    };

    const chapterCount = root.c?.length || 0;
    const btn = 'text-[11px] px-2 py-0.5 rounded-full border transition-colors';
    const btnOn = 'border-zinc-700 bg-zinc-800 text-white';
    const btnOff = 'border-zinc-200 text-zinc-500 hover:border-zinc-400 hover:text-zinc-700';

    return (
        <div data-mindmap="json" data-mm-chapters={chapterCount} data-mm-ready={ready ? '1' : '0'}>
            <div className="flex items-center justify-between mb-1.5 flex-wrap gap-1">
                <span className="text-[11px] text-zinc-400 tabular-nums">
                    {chapterCount > 1 ? `${chapterCount} 章 · 拖拽平移 · 滚轮缩放 · 点章节点的圆圈生成并展开详分支` : ''}
                </span>
                <div className="flex items-center gap-1 flex-wrap" data-mm-toolbar>
                    {[1, 2].map(lv => (
                        <button key={lv} className={`${btn} ${level === lv ? btnOn : btnOff}`}
                            onClick={() => { setLevel(lv); setRebuildKey(k => k + 1); }}>
                            {lv === 1 ? '展开到章' : '展开到主题'}
                        </button>
                    ))}
                    <button className={`${btn} ${level === Infinity ? btnOn : btnOff}`}
                        onClick={() => { setLevel(Infinity); setRebuildKey(k => k + 1); }}>全部</button>
                    <button className={`${btn} ${btnOff}`} onClick={() => mmRef.current?.fit().catch(() => {})}>回中</button>
                    <button className={`${btn} ${btnOff}`} onClick={exportSvg} title="导出可在任意软件缩放的矢量图">SVG</button>
                    <button className={`${btn} ${btnOff}`} onClick={exportPng} title="导出 2x 位图">PNG</button>
                    <button className={`${btn} ${btnOff}`} onClick={() => setFullscreen(true)}>放大</button>
                </div>
            </div>
            <div
                onClick={handleCanvasClick}
                className={fullscreen
                    ? 'fixed inset-0 z-50 bg-white'
                    : 'relative bg-white rounded-xl border border-zinc-100 overflow-hidden'}
                style={fullscreen ? undefined : { height }}
            >
                {fullscreen && (
                    <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-6 py-3 bg-white/85 backdrop-blur border-b border-zinc-100">
                        <h2 className="text-base font-serif-heading font-semibold text-zinc-800 truncate">{root.t}</h2>
                        <button onClick={() => setFullscreen(false)} className="p-2 rounded-full hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-all" title="关闭">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                )}
                <svg ref={svgRef} className="w-full h-full" style={{ display: 'block' }}></svg>
            </div>
        </div>
    );
}

// ---------- 知识卡片产出（v2.3）：artifact data = {note, cards:[{front,back,cite,box,...}]} ----------
function parseCardsResult(raw) {
    try {
        const o = JSON.parse((raw || '').trim());
        if (o && Array.isArray(o.cards)) return o;
    } catch { /* 非 JSON（旧数据/降级文本）走文本渲染 */ }
    return null;
}

function CardsResult({ data }) {
    return (
        <div className="space-y-2.5" data-tool-cards>
            <p className="text-sm text-zinc-600">{data.note || ''}</p>
            {data.cards.map((c, i) => (
                <div key={c.card_id || i} className="rounded-xl border border-zinc-100 bg-zinc-50/60 px-3.5 py-2.5">
                    <p className="text-xs font-medium text-zinc-800 leading-relaxed" data-card-front>{c.front}</p>
                    <p className="text-xs text-zinc-500 leading-relaxed mt-1" data-card-back>{c.back}</p>
                    {c.cite && <p className="text-[11px] text-zinc-400 italic mt-1 border-l-2 border-zinc-100 pl-2 leading-relaxed">「{c.cite}」</p>}
                </div>
            ))}
        </div>
    );
}

// ---------- 工具产出消息卡（v2.0：产出即消息，流进对话流） ----------
function ToolMessageCard({ msg, bookId, favorites, onToggleFavorite, onNavigateToSource }) {
    const [mindmapExpanded, setMindmapExpanded] = useState(false);
    const [htmlExpanded, setHtmlExpanded] = useState(false);
    const streaming = !!msg.streaming;
    const content = msg.content || '';
    // 思维导图双路径：v2.1 起为 JSON 结构树；存量旧消息是 Markdown，继续走 markmap
    const mmRoot = msg.tool_id === 'mindmap' && !streaming ? parseMindmapJson(content) : null;

    // v2.4 资产区：html artifact 与导图 JSON 也可归档（资产区分别走 iframe 与树重放）
    const canFavorite = !streaming && !msg.error && content.trim();
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
                            onClick={() => onToggleFavorite({ type: 'tool', toolId: msg.tool_id, toolLabel: msg.tool_name, outputType: msg.output_type || 'text', question: msg.scope || '整本书', answer: content })}
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
                    ) : msg.output_type === 'cards' && parseCardsResult(content) ? (
                        <CardsResult data={parseCardsResult(content)} />
                    ) : msg.output_type === 'audio' && !streaming && content.trim() ? (
                        <div className="space-y-2" data-audio-card>
                            <p className="text-xs text-zinc-400">双主播对谈 · 成品已存 data/audio，可点右上角收藏进资产区</p>
                            <audio controls preload="metadata" src={content} className="w-full" data-audio-src={content} />
                        </div>
                    ) : msg.tool_id === 'mindmap' && !streaming && content.trim() ? (
                        mmRoot
                            ? <MindmapTree root={mmRoot} bookId={bookId} onNavigateToSource={onNavigateToSource} />
                            : <MindmapSvg data={content} onExpand={() => setMindmapExpanded(true)} />
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
