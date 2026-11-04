import { useState, useRef, useEffect } from 'react';
import { TOOLS, TOOL_NEEDS_INPUT } from '../tools.js';

// 工具抽屉：顶栏「工具」唤出（右侧满高，与目录抽屉镜像），带标题、范围切换、工具名与说明；
// 点击工具即运行（产出落进对话流并自动展开 AI 区），作者对谈先内联输入问题
function ToolDrawer({ disabled, busyToolId, onRunTool, scopeLabel, scopeAll, onScopeChange, hasChapter, onClose }) {
    const [openInput, setOpenInput] = useState(null);   // 展开输入面板的工具 id（author-talk / podcast）
    const [talkInput, setTalkInput] = useState('');
    const [pcTopic, setPcTopic] = useState('');
    const [pcMinutes, setPcMinutes] = useState(20);
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
            onClose();
        }
    };

    const submitTalk = () => {
        if (!talkInput.trim()) return;
        onRunTool('author-talk', talkInput.trim(), scopeAll);
        setTalkInput('');
        setOpenInput(null);
        onClose();
    };

    const submitPodcast = () => {
        if (!pcTopic.trim()) return;
        // 播客以整本书为素材面，作用范围固定整本书；minutes 决定台本目标字数
        onRunTool('podcast', pcTopic.trim(), true, pcMinutes);
        setPcTopic('');
        setOpenInput(null);
        onClose();
    };

    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className="fixed right-0 top-0 bottom-0 z-50 w-72 bg-white border-l border-zinc-200 shadow-2xl flex flex-col" style={{ animation: 'fade-in 0.2s ease-out' }}>
                {/* 标题栏 */}
                <div className="px-4 pt-4 pb-3 flex-shrink-0 border-b border-zinc-100">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-serif-heading font-semibold text-zinc-800">AI 工具</h3>
                        <button onClick={onClose} className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-50 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
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
                </div>

                {/* 工具列表：图标 + 名称 + 说明 */}
                <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
                    {TOOLS.map(tool => {
                        const busy = busyToolId === tool.id;
                        return (
                            <div key={tool.id}>
                                <button
                                    onClick={() => handleToolClick(tool)}
                                    disabled={disabled}
                                    title={`${tool.label} · ${scopeAll ? '整本书' : scopeLabel}`}
                                    className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${busy ? 'bg-zinc-100' : 'hover:bg-zinc-50'} ${TOOL_NEEDS_INPUT[tool.id] && openInput === tool.id ? 'bg-zinc-50' : ''}`}
                                >
                                    <span className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${busy ? 'bg-zinc-800 border-zinc-800 text-white' : 'border-zinc-200 text-zinc-500'}`}>
                                        <svg className={`w-4 h-4 ${busy ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tool.icon} />
                                        </svg>
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[13px] font-medium text-zinc-700">{tool.label}</span>
                                        <span className="block text-[11px] text-zinc-400 mt-0.5 truncate">
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
                                    <div className="px-2.5 pb-2 pt-0.5 space-y-2">
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
                                                        className={`px-2.5 py-1 transition-colors ${pcMinutes === m ? 'bg-zinc-800 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}
                                                    >{m} 分钟</button>
                                                ))}
                                            </div>
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
                                    <div className="flex gap-2 px-2.5 pb-1 pt-0.5">
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
        </>
    );
}

export default ToolDrawer;
