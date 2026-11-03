// AI 工具元数据：ToolRail（图标栏）与 ToolMessageCard（对话流卡片）共用
// 与后端 routers/tools.py 的注册表一一对应（v1.9 已删 background/recommend，勿加回）
export const TOOLS = [
    { id: 'summarize', label: '总结', desc: '总结整本书或当前选中章节', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
    { id: 'questions', label: '读书十问', desc: '十个深度问题帮你吃透一本书', icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { id: 'mindmap', label: '思维导图', desc: '按当前范围生成知识框架与逻辑脉络', icon: 'M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4' },
    { id: 'author-talk', label: '与作者对谈', desc: '基于书中论点向作者提问', icon: 'M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
    { id: 'knowledge-graph', label: '精读笔记', desc: '生成可下载的精读笔记页', icon: 'M4 6h16M4 12h16M4 18h16M8 2v4m8-4v4M8 16v4m8-4v4' },
];

export const TOOL_LABELS = Object.fromEntries(TOOLS.map(t => [t.id, t.label]));

// 仅「与作者对谈」需要先输入问题；其余工具的作用范围 = 当前选中章（未选中则整本书）
export const TOOL_NEEDS_INPUT = { 'author-talk': true };
