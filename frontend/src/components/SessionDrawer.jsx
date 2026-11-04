function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return hm;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const ChatIcon = ({ className }) => (
    <svg className={className || 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
);

// 会话抽屉：顶栏「会话」唤出（左侧满高，与工具/收藏抽屉同款镜像）；新建/切换/删除
function SessionDrawer({ sessions = [], currentSessionId, onNewSession, onSelectSession, onDeleteSession, experts = [], disabled = false, onClose }) {
    const expertNameOf = (id) => experts.find(e => e.expert_id === id)?.name;

    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className="fixed left-0 top-0 bottom-0 z-50 w-72 bg-white border-r border-zinc-200 shadow-2xl flex flex-col" style={{ animation: 'fade-in 0.2s ease-out' }}>
                <div className="px-4 pt-4 pb-3 border-b border-zinc-100 flex items-center gap-2 flex-shrink-0">
                    <h3 className="text-sm font-serif-heading font-semibold text-zinc-800">会话</h3>
                    {sessions.length > 0 && (
                        <span className="text-[11px] text-zinc-400 tabular-nums">({sessions.length})</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                        <button
                            onClick={() => { onNewSession(); onClose(); }}
                            disabled={disabled}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50 transition-all disabled:opacity-40"
                            title="新对话"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                        </button>
                        <button onClick={onClose} className="p-1 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-50 transition-all" title="关闭">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-0.5">
                    {sessions.length === 0 ? (
                        <div className="text-center py-10">
                            <ChatIcon className="w-8 h-8 mx-auto text-zinc-200 mb-2" />
                            <p className="text-xs text-zinc-300">暂无会话</p>
                        </div>
                    ) : sessions.map(s => (
                        <div
                            key={s.session_id}
                            onClick={() => { onSelectSession(s.session_id); onClose(); }}
                            className={`group px-2.5 py-2 rounded-lg cursor-pointer transition-all ${s.session_id === currentSessionId ? 'bg-zinc-50 ring-1 ring-zinc-200' : 'hover:bg-zinc-50'}`}
                        >
                            <div className="flex items-start gap-1.5">
                                <ChatIcon className="w-3.5 h-3.5 text-zinc-300 flex-shrink-0 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                    <div className={`truncate text-[13px] ${s.session_id === currentSessionId ? 'text-zinc-800 font-medium' : 'text-zinc-600'}`}>{s.title}</div>
                                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-0.5">
                                        <span className="truncate">{fmtTime(s.updated_at)} · {s.message_count} 条</span>
                                        {s.expert_id && expertNameOf(s.expert_id) && (
                                            <span className="px-1 py-px rounded bg-zinc-100 text-zinc-500 border border-zinc-200 flex-shrink-0 text-[10px]">{expertNameOf(s.expert_id)}</span>
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onDeleteSession(s.session_id); }}
                                    className="opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-red-400 transition-all text-xs px-1 flex-shrink-0"
                                    title="删除"
                                >
                                    ✕
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

export default SessionDrawer;
