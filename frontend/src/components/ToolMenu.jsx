import { useState, useRef, useEffect } from 'react';
import { TOOLS, TOOL_NEEDS_INPUT } from '../tools.js';

// ➕ 级联二级面板·工具（v3.1）：原顶栏工具抽屉迁入 AI 面板加号菜单。
// 范围切换 + 工具列表 + 作者对谈/播客内联输入；点普通工具即运行并收起菜单。
// 与专家列表同侧向左展开（AiPanel 负责定位），自身只渲染一块 w-80 面板。
function ToolMenu({ disabled, busyToolId, onRunTool, scopeLabel, scopeAll, onScopeChange, hasChapter, onActioned }) {
    const [openInput, setOpenInput] = useState(null);   // 展开输入面板的工具 id（author-talk / podcast）
    const [talkInput, setTalkInput] = useState('');
    const [pcTopic, setPcTopic] = useState('');
    const [pcMinutes, setPcMinutes] = useState(20);
    const [pcRegen, setPcRegen] = useState(false);      // v2.8-B：不复用往期，强制新一期
    const inputRef = useRef(null);

    useEffect(() => {
        if (openInput) setTimeout(() => inputRef.current?.focus(), 50);
    }, [openInput]);

    const handleToolClick = (tool) => {
        if (disabled) return;
        if (TOOL_NEEDS_INPUT[tool.id]) {
            setOpenInput(cur => (cur === tool.id ? null : tool.id));
        } else {
            onRunTool(tool.id, null, scopeAll);
            onActioned();
        }
    };

    const submitTalk = () => {
        if (!talkInput.trim()) return;
        onRunTool('author-talk', talkInput.trim(), scopeAll);
        setTalkInput('');
        setOpenInput(null);
        onActioned();
    };

    const submitPodcast = () => {
        if (!pcTopic.trim()) return;
        // 播客以整本书为素材面，作用范围固定整本书；minutes 决定台本目标字数
        onRunTool('podcast', pcTopic.trim(), true, pcMinutes, { regen: pcRegen });
        setPcTopic('');
        setPcRegen(false);
        setOpenInput(null);
        onActioned();
    };

    return (
        <div data-tool-menu className="w-80 bg-white border border-zinc-200 rounded-xl shadow-lg flex flex-col max-h-[28rem] overflow-hidden">
            {/* 范围切换（testid 沿用原工具抽屉，选择器不断） */}
            <div className="px-3 pt-2.5 pb-2 border-b border-zinc-100 flex items-center gap-2 flex-shrink-0">
                <span className="text-[11px] text-zinc-400 flex-shrink-0">范围</span>
                <div className="flex rounded-lg border border-zinc-200 overflow-hidden text-[11px] flex-shrink-0" data-testid="tool-scope">
                    <button
                        onClick={() => onScopeChange(false)}
                        disabled={!hasChapter}
                        className={`px-2.5 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${!scopeAll ? 'bg-zinc-800 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}
                    >当前章</button>
                    <button
                        onClick={() => onScopeChange(true)}
                        className={`px-2.5 py-1 transition-colors ${scopeAll ? 'bg-zinc-800 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}
                    >整本书</button>
                </div>
                {!scopeAll && hasChapter && <span className="text-[11px] text-zinc-400 truncate">{scopeLabel}</span>}
            </div>

            {/* 工具列表：图标 + 名称 + 说明 */}
            <div className="flex-1 overflow-y-auto scrollbar-thin p-1.5 space-y-0.5">
                {TOOLS.map(tool => {
                    const busy = busyToolId === tool.id;
                    return (
                        <div key={tool.id}>
                            <button
                                onClick={() => handleToolClick(tool)}
                                disabled={disabled}
                                title={`${tool.label} · ${scopeAll ? '整本书' : scopeLabel}`}
                                className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${busy ? 'bg-zinc-100' : 'hover:bg-zinc-50'} ${TOOL_NEEDS_INPUT[tool.id] && openInput === tool.id ? 'bg-zinc-50' : ''}`}
                            >
                                <span className={`w-7 h-7 rounded-lg border flex items-center justify-center flex-shrink-0 ${busy ? 'bg-zinc-800 border-zinc-800 text-white' : 'border-zinc-200 text-zinc-500'}`}>
                                    <svg className={`w-3.5 h-3.5 ${busy ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tool.icon} />
                                    </svg>
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[13px] font-medium text-zinc-700">{tool.label}</span>
                                    <span className="block text-[11px] text-zinc-400 mt-px truncate">
                                        {busy ? '生成中，产出见对话流…' : tool.desc}
                                    </span>
                                </span>
                                {TOOL_NEEDS_INPUT[tool.id] && (
                                    <svg className={`w-3.5 h-3.5 text-zinc-300 flex-shrink-0 transition-transform ${openInput === tool.id ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                )}
                            </button>
                            {/* 读书播客：主题 + 时长档（10/20/30 分钟） */}
                            {tool.id === 'podcast' && openInput === 'podcast' && (
                                <div className="px-2 pb-2 pt-0.5 space-y-2">
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={pcTopic}
                                        onChange={e => setPcTopic(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPodcast(); } }}
                                        placeholder="本期主题"
                                        data-podcast-topic
                                        className="w-full px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-full text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-400"
                                    />
                                    <div className="flex items-center gap-2">
                                        <div className="inline-flex rounded-lg border border-zinc-200 overflow-hidden text-[11px]" data-podcast-minutes>
                                            {[10, 20, 30].map(m => (
                                                <button
                                                    key={m}
                                                    onClick={() => setPcMinutes(m)}
                                                    className={`px-2 py-1 transition-colors ${pcMinutes === m ? 'bg-zinc-800 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}
                                                >{m} 分钟</button>
                                            ))}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setPcRegen(v => !v)}
                                            aria-pressed={pcRegen}
                                            data-podcast-regen
                                            className={`px-2 py-1 rounded-lg border text-[11px] transition-colors flex-shrink-0 ${pcRegen ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50'}`}
                                        >
                                            重新生成一期
                                        </button>
                                        <button
                                            onClick={submitPodcast}
                                            disabled={!pcTopic.trim() || disabled}
                                            className="ml-auto px-3 py-1 bg-zinc-800 text-white rounded-full text-xs font-medium hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
                                        >
                                            生成
                                        </button>
                                    </div>
                                </div>
                            )}
                            {/* 与作者对谈：内联提问输入 */}
                            {tool.id === 'author-talk' && openInput === 'author-talk' && (
                                <div className="flex gap-2 px-2 pb-1.5 pt-0.5">
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={talkInput}
                                        onChange={e => setTalkInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTalk(); } }}
                                        placeholder="向作者提问"
                                        className="flex-1 min-w-0 px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-full text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-transparent placeholder:text-zinc-400"
                                    />
                                    <button
                                        onClick={submitTalk}
                                        disabled={!talkInput.trim() || disabled}
                                        className="px-3 py-1.5 bg-zinc-800 text-white rounded-full text-xs font-medium hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
                                    >
                                        提问
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default ToolMenu;
