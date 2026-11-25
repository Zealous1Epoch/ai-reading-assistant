// v3.5 外观设置：主题（浅色/深色/跟随系统）+ 阅读区纸张 + 字号
// 全局单例 localStorage('app_appearance')；改动后 applyTheme + 广播 'wb-appearance'，
// 阅读区等订阅方即时响应（不用层层传 props，也不进后端——纯本机偏好）。

const KEY = 'app_appearance';

export const PAPER_THEMES = {
    white:  { label: '白纸',   bg: '#ffffff', border: '#e4e4e7', fg: '#3f3f46', strong: '#18181b', muted: '#a1a1aa', panel: '#fafafa', swatch: '#ffffff' },
    cream:  { label: '米黄',   bg: '#faf3e3', border: '#eadfc6', fg: '#57472e', strong: '#3a2f1d', muted: '#b09d7c', panel: '#f3ead6', swatch: '#faf3e3' },
    eye:    { label: '护眼绿', bg: '#e8f0e4', border: '#d4e2cf', fg: '#3d4a3a', strong: '#26301f', muted: '#94a68e', panel: '#dfebdd', swatch: '#e8f0e4' },
    dark:   { label: '深色纸', bg: '#1f1f23', border: '#3a3a41', fg: '#b9b9c3', strong: '#e6e6ec', muted: '#6e6e79', panel: '#27272d', swatch: '#1f1f23' },
};

export const DEFAULT_APPEARANCE = { theme: 'system', paper: 'white', fontSize: 15 };

export function loadAppearance() {
    try {
        const s = JSON.parse(localStorage.getItem(KEY) || '{}');
        const a = { ...DEFAULT_APPEARANCE, ...s };
        if (!['light', 'dark', 'system'].includes(a.theme)) a.theme = 'system';
        if (!PAPER_THEMES[a.paper]) a.paper = 'white';
        a.fontSize = Math.min(22, Math.max(13, Number(a.fontSize) || 15));
        return a;
    } catch {
        return { ...DEFAULT_APPEARANCE };
    }
}

export function applyTheme(theme) {
    const t = theme || loadAppearance().theme;
    const dark = t === 'dark'
        || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
}

export function saveAppearance(patch) {
    const next = { ...loadAppearance(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 隐私模式忽略 */ }
    applyTheme(next.theme);
    window.dispatchEvent(new Event('wb-appearance'));
    return next;
}

// 模块装载即应用一次（App import 时执行，避免首帧闪错色）；跟随系统时监听切换
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (loadAppearance().theme === 'system') applyTheme('system');
});
