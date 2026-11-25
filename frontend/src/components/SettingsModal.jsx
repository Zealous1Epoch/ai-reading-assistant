import { useState, useEffect } from 'react';
import { loadAppearance, saveAppearance, PAPER_THEMES } from '../appearance.js';

const API_BASE = '';

// v3.5 设置面板：外观（主题/纸张/字号）· AI 模型（端点/模型/Key，改动即时生效）· 语音合成 · 数据导出
// 弹层在右缘工具条附近？不——设置是全局功能，走居中模态，Esc/点遮罩关闭。

const VOICE_PRESETS = [
    { v: 'zh-CN-YunxiNeural', l: '云希 · 男（活力，默认A）' },
    { v: 'zh-CN-YunjianNeural', l: '云健 · 男（沉稳）' },
    { v: 'zh-CN-YunyeNeural', l: '云野 · 男（温暖）' },
    { v: 'zh-CN-YunxiaNeural', l: '云夏 · 男（少年）' },
    { v: 'zh-CN-XiaoxiaoNeural', l: '晓晓 · 女（柔和）' },
    { v: 'zh-CN-XiaoyiNeural', l: '晓伊 · 女（活泼，默认B）' },
    { v: 'zh-CN-XiaohanNeural', l: '晓涵 · 女（知性）' },
    { v: 'zh-CN-XiaoxuanNeural', l: '晓萱 · 女（甜美）' },
];

const RATE_PRESETS = ['-10%', '-5%', '+0%', '+9%', '+15%', '+20%'];

function Section({ title, note, children }) {
    return (
        <section className="border-t border-zinc-100 dark:border-zinc-800 pt-4 first:border-t-0 first:pt-0">
            <h3 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">{title}</h3>
            {children}
            {note && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-2 leading-relaxed">{note}</p>}
        </section>
    );
}

const inputCls = 'w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-sm text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400 placeholder:text-zinc-300';
const btnCls = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-600 transition-all disabled:opacity-50';
const primaryBtnCls = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 dark:bg-zinc-700 text-white hover:bg-zinc-900 dark:hover:bg-zinc-600 transition-all disabled:opacity-50';

export default function SettingsModal({ onClose }) {
    const [ap, setAp] = useState(loadAppearance);
    const [remote, setRemote] = useState(null);   // 后端 /api/settings 返回
    const [form, setForm] = useState({ base_url: '', model: '', api_key: '' });
    const [tts, setTts] = useState({ voice_a: '', voice_b: '', rate: '' });
    const [llmMsg, setLlmMsg] = useState(null);   // {ok, detail}
    const [ttsMsg, setTtsMsg] = useState(null);
    const [busy, setBusy] = useState('');
    // 数据未回时锁表单：迟到的 GET 响应会把用户刚做的选择覆盖回旧值（禁用=物理防呆）
    const lockCls = remote === null ? 'opacity-50 pointer-events-none' : '';         // '' | 'test' | 'save-llm' | 'save-tts' | 'export'

    useEffect(() => {
        const h = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    useEffect(() => {
        fetch(`${API_BASE}/api/settings`)
            .then(r => r.json())
            .then(d => {
                setRemote(d);
                setForm(f => ({ ...f, base_url: d.llm?.base_url || '', model: d.llm?.model || '' }));
                setTts({ voice_a: d.tts?.voice_a || '', voice_b: d.tts?.voice_b || '', rate: d.tts?.rate || '+9%' });
            })
            .catch(() => setRemote({}));
    }, []);

    const testLlm = async () => {
        setBusy('test'); setLlmMsg(null);
        try {
            const res = await fetch(`${API_BASE}/api/settings/llm/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_url: form.base_url, model: form.model, api_key: form.api_key || null }),
            });
            setLlmMsg(await res.json());
        } catch (e) {
            setLlmMsg({ ok: false, detail: `请求失败：${e.message}` });
        } finally { setBusy(''); }
    };

    const saveLlm = async () => {
        setBusy('save-llm'); setLlmMsg(null);
        try {
            const res = await fetch(`${API_BASE}/api/settings/llm`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_url: form.base_url, model: form.model, api_key: form.api_key || null }),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.detail || res.status);
            setRemote(d);
            setForm(f => ({ ...f, api_key: '' }));
            setLlmMsg({ ok: true, detail: '已保存，立即生效（不必重启）' });
        } catch (e) {
            setLlmMsg({ ok: false, detail: `保存失败：${e.message}` });
        } finally { setBusy(''); }
    };

    const saveTts = async () => {
        setBusy('save-tts'); setTtsMsg(null);
        try {
            const res = await fetch(`${API_BASE}/api/settings/tts`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tts),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.detail || res.status);
            setRemote(d);
            setTtsMsg({ ok: true, detail: '已保存：新合成的听书/播客生效' });
        } catch (e) {
            setTtsMsg({ ok: false, detail: `保存失败：${e.message}` });
        } finally { setBusy(''); }
    };

    const exportAll = async () => {
        setBusy('export'); setTtsMsg(null);
        try {
            const res = await fetch(`${API_BASE}/api/assets/export`);
            if (res.status === 404) { setTtsMsg({ ok: false, detail: '资产区还是空的，没有可导出的内容' }); return; }
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '全部资产_导出.md';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setTtsMsg({ ok: false, detail: `导出失败：${e.message}` });
        } finally { setBusy(''); }
    };

    const selCls = 'w-full px-2 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-xs text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" data-testid="settings-modal">
            <div className="absolute inset-0 bg-zinc-900/40 backdrop-blur-[2px]" onClick={onClose} />
            <div className="relative w-full max-w-lg max-h-[86vh] overflow-y-auto scrollbar-thin bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xl p-6 space-y-5"
                 onClick={e => e.stopPropagation()}
                 data-ready={remote !== null ? "1" : "0"}>
                <div className="flex items-center justify-between">
                    <h2 className="text-base font-serif-heading font-semibold text-zinc-900 dark:text-zinc-100">设置</h2>
                    <button onClick={onClose} className="text-zinc-300 hover:text-zinc-500 dark:hover:text-zinc-400 text-lg leading-none px-1" title="关闭">×</button>
                </div>

                {/* —— 外观 —— */}
                <Section title="外观">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">主题</span>
                            <div className="flex gap-1">
                                {[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([v, l]) => (
                                    <button key={v} data-ap-theme={v}
                                        onClick={() => setAp(saveAppearance({ theme: v }))}
                                        className={`px-2.5 py-1 rounded-lg text-xs border transition-all ${ap.theme === v ? 'bg-zinc-800 dark:bg-zinc-700 text-white border-zinc-800' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-600'}`}>
                                        {l}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">阅读纸张</span>
                            <div className="flex gap-1.5">
                                {Object.entries(PAPER_THEMES).map(([k, p]) => (
                                    <button key={k} data-ap-paper={k} title={p.label}
                                        onClick={() => setAp(saveAppearance({ paper: k }))}
                                        className={`w-9 h-6 rounded-md border-2 transition-all ${ap.paper === k ? 'border-zinc-800' : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600'}`}
                                        style={{ background: p.swatch }} />
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">字号</span>
                            <div className="flex items-center gap-2 flex-1 max-w-[240px]">
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">小</span>
                                <input data-ap-fontsize type="range" min="13" max="22" step="1" value={ap.fontSize}
                                    onChange={e => setAp(saveAppearance({ fontSize: Number(e.target.value) }))}
                                    className="flex-1 accent-zinc-700 dark:accent-zinc-300" />
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">大</span>
                                <span className="text-xs text-zinc-600 dark:text-zinc-300 tabular-nums w-8 text-right" data-ap-fontsize-val>{ap.fontSize}px</span>
                            </div>
                        </div>
                    </div>
                </Section>

                {/* —— AI 模型 —— */}
                <Section title="AI 模型（LLM）" note="保存即生效，不必重启后端；改动只影响此后新发起的对话/工具。API Key 留空 = 保持原值不动。">
                    <div className={`space-y-2 ${lockCls}`}>
                        <div className="flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500">
                            <span>当前 Key：<span className="tabular-nums">{remote ? (remote.llm?.api_key_set ? remote.llm.api_key_masked : '未配置') : '…'}</span></span>
                        </div>
                        <label className="block">
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">接口地址（base_url）</span>
                            <input data-set-baseurl className={inputCls} value={form.base_url} placeholder="https://api.example.com/v1"
                                onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))} />
                        </label>
                        <label className="block">
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">模型名</span>
                            <input data-set-model className={inputCls} value={form.model} placeholder="deepseek-chat"
                                onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
                        </label>
                        <label className="block">
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">API Key（留空不改）</span>
                            <input data-set-key type="password" className={inputCls} value={form.api_key} placeholder="••••••••" autoComplete="off"
                                onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))} />
                        </label>
                        <div className="flex items-center gap-2 pt-1">
                            <button data-set-llm-test onClick={testLlm} disabled={busy === 'test' || remote === null} className={btnCls}>
                                {busy === 'test' ? '测试中…' : '测试连接'}
                            </button>
                            <button data-set-llm-save onClick={saveLlm} disabled={busy === 'save-llm' || remote === null} className={primaryBtnCls}>
                                {busy === 'save-llm' ? '保存中…' : '保存'}
                            </button>
                        </div>
                        {llmMsg && (
                            <p data-set-llm-result className={`text-[11px] break-all ${llmMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>{llmMsg.detail}</p>
                        )}
                    </div>
                </Section>

                {/* —— 语音合成 —— */}
                <Section title="语音合成（听书 / 播客）" note="edge-tts 免费音色。换音色/语速后：已生成的旧音频仍按原样缓存播放，新合成的才用新配置。">
                    <div className={`grid grid-cols-3 gap-2 ${lockCls}`}>
                        <label className="block">
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">主播 A / 听书</span>
                            <select data-set-voice-a className={selCls} value={tts.voice_a} onChange={e => setTts(t => ({ ...t, voice_a: e.target.value }))}>
                                {VOICE_PRESETS.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}
                            </select>
                        </label>
                        <label className="block">
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">主播 B</span>
                            <select data-set-voice-b className={selCls} value={tts.voice_b} onChange={e => setTts(t => ({ ...t, voice_b: e.target.value }))}>
                                {VOICE_PRESETS.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}
                            </select>
                        </label>
                        <label className="block">
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">播客语速</span>
                            <select data-set-rate className={selCls} value={tts.rate} onChange={e => setTts(t => ({ ...t, rate: e.target.value }))}>
                                {RATE_PRESETS.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                        </label>
                    </div>
                    <div className="flex items-center gap-2 pt-2">
                        <button data-set-tts-save onClick={saveTts} disabled={busy === 'save-tts' || remote === null} className={primaryBtnCls}>
                            {busy === 'save-tts' ? '保存中…' : '保存'}
                        </button>
                        {ttsMsg && (
                            <span data-set-tts-result className={`text-[11px] break-all ${ttsMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>{ttsMsg.detail}</span>
                        )}
                    </div>
                </Section>

                {/* —— 数据 —— */}
                <Section title="数据" note="资产区全部条目（笔记/工具产出/报告）导出为单个 Markdown 文件。">
                    <button data-set-export onClick={exportAll} disabled={busy === 'export'} className={btnCls}>
                        {busy === 'export' ? '导出中…' : '导出全部资产（.md）'}
                    </button>
                </Section>
            </div>
        </div>
    );
}
