// v2.9 思维导图（markmap 画布版）浏览器级 E2E：
// 范围切换 → 全书图画布渲染 → 章数=跳转链接数 → 点章跳原文 → 层级切换 → 按需展开详分支 → 全屏 → SVG 导出 → 落盘与追问上下文
// 运行：node tests/e2e_mindmap.cjs（需服务已在 127.0.0.1:8000 运行；全书骨架走真实 LLM，预留数分钟）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');

const BASE = 'http://127.0.0.1:8000';
let PASS = 0, FAIL = 0;
const say = (name, cond, extra) => {
    if (cond) { PASS++; console.log('  ok  ', name, extra || ''); }
    else { FAIL++; console.log('  FAIL', name, extra || ''); }
};

function api(method, path) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE + path, { method }, res => {
            let b = '';
            res.on('data', d => (b += d));
            res.on('end', () => resolve(b));
        });
        req.on('error', reject);
        req.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 画布中"可见节点"计数：markmap 折叠的子树不进 DOM，foreignObject 数即当前渲染节点数
const visibleNodes = page => page.evaluate(() =>
    document.querySelectorAll('[data-mindmap="json"] .markmap-foreign').length);

const BOOK = '非暴力沟通';

let browser = null;
(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    // 资源 404（孤章 fetch 失败）是预期业务情形，已有"本章内容缺失"兜底，单独过滤；JS 运行错误仍算错
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    // ---- 1 进书 ----
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.locator('button').filter({ hasText: BOOK }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    const bookId = decodeURIComponent(page.url().split('#/book/')[1]);
    say('进书', bookId.length > 0, bookId.slice(0, 8));

    const realTitles = JSON.parse(await api('GET', '/books/analysis/' + encodeURIComponent(bookId)));
    say('书目加载', (realTitles.chapters || []).length >= 16, (realTitles.chapters || []).length + ' 章(目录口径)');

    let loadSettled = false;
    for (let i = 0; i < 20 && !loadSettled; i++) {
        await sleep(1000);
        loadSettled = await page.evaluate(() => !document.body.innerText.includes('章节加载中'));
    }
    say('章节加载有终态（不永远转圈）', loadSettled);

    // ---- 2 会话隔离 + 工具抽屉范围切到整本书 ----
    await page.locator('button[title="会话"]').click();
    let sessDrawer = false;
    for (let i = 0; i < 10 && !sessDrawer; i++) {
        await sleep(300);
        sessDrawer = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '会话'));
    }
    say('会话抽屉打开', sessDrawer);
    await page.locator('button[title="新对话"]').click();
    await sleep(600);
    say('新对话后抽屉自动收起', await page.evaluate(() => !Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '会话')));
    say('已重置为新对话', await page.evaluate(() => document.body.innerText.includes('暂无对话')));
    const baseline = new Set(JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId))).sessions.map(s => s.session_id));
    await page.locator('button[title="工具"]').click();
    let drawerOpen = false;
    for (let i = 0; i < 10 && !drawerOpen; i++) {
        await sleep(300);
        drawerOpen = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === 'AI 工具'));
    }
    say('工具抽屉打开', drawerOpen);
    say('范围切换器就位', await page.locator('[data-testid="tool-scope"]').isVisible());
    await page.locator('[data-testid="tool-scope"] button').filter({ hasText: '整本书' }).click();
    say('切到整本书高亮', await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('[data-testid="tool-scope"] button'));
        return btns[btns.length - 1].className.includes('bg-zinc-800');
    }));

    // ---- 3 运行全书思维导图 → markmap 画布渲染 ----
    await page.locator('button[title^="思维导图 · 整本书"]').first().click();
    say('运行后抽屉自动关闭', await page.evaluate(() => !Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === 'AI 工具')));
    let treeReady = false;
    try {
        await page.waitForSelector('[data-mindmap="json"][data-mm-ready="1"]', { timeout: 300000 });
        treeReady = true;
    } catch { /* 下面断言会记 FAIL */ }
    say('全书导图画布渲染（300s 内 ready）', treeReady);
    if (!treeReady) { await page.screenshot({ path: '/tmp/v29_fail_tree.png' }); throw new Error('导图未出现，终止后续断言'); }
    await sleep(800); // 等首帧过渡动画结束

    const mmAttr = await page.evaluate(() => {
        const el = document.querySelector('[data-mindmap="json"]');
        return {
            chapters: Number(el.getAttribute('data-mm-chapters')),
            jumps: document.querySelectorAll('[data-mindmap="json"] [data-mm-jump]').length,
            expands: document.querySelectorAll('[data-mindmap="json"] [data-mm-expand]').length,
            svgNodes: document.querySelectorAll('[data-mindmap="json"] svg g').length,
        };
    });
    say('章数=跳转链接数', mmAttr.chapters === mmAttr.jumps, JSON.stringify(mmAttr));
    say('章数=详分支按钮数', mmAttr.chapters === mmAttr.expands);
    say('章数 >= 16（与后端目录一致）', mmAttr.chapters >= 16, String(mmAttr.chapters));
    const baseNodes = await visibleNodes(page);
    say('默认展开到章：渲染节点=1根+N章', baseNodes === mmAttr.chapters + 1, `渲染 ${baseNodes}`);
    await page.screenshot({ path: '/tmp/v29_canvas.png' });

    // ---- 4 层级切换：展开到主题 → 节点变多 ----
    await page.locator('[data-mm-toolbar] button').filter({ hasText: '展开到主题' }).click();
    await sleep(1200);
    const topicNodes = await visibleNodes(page);
    say('展开到主题节点增多', topicNodes > baseNodes, `${baseNodes} → ${topicNodes}`);
    await page.screenshot({ path: '/tmp/v29_topics.png' });

    // ---- 5 点章名跳原文（画布内 <a> 事件委托） ----
    const cid5 = await page.locator('[data-mm-jump]').nth(5).getAttribute('data-mm-jump');
    const targetTitle = (await page.locator(`[data-mm-jump="${cid5}"]`).first().innerText()).trim();
    await page.evaluate(c => document.querySelector('[data-mm-jump="'.concat(c, '"]')).click(), cid5);
    await sleep(1500);
    const paneTitle = (await page.locator('h2').filter({ hasText: targetTitle }).first().innerText()).trim();
    say('点章名跳到原文（章头标题一致）', paneTitle === targetTitle, targetTitle);

    // ---- 6 按需展开详分支（LLM 生成四级子树） ----
    const expandBefore = await visibleNodes(page);
    await page.evaluate(c => document.querySelector('[data-mm-expand="'.concat(c, '"]')).click(), cid5);
    let expandDone = false;
    for (let i = 0; i < 240 && !expandDone; i++) {
        await sleep(1000);
        expandDone = await page.evaluate((b) => !document.querySelector(`[data-mm-expand="${b}"], [data-mm-loading="${b}"]`), cid5);
    }
    await page.locator('[data-mm-toolbar] button').filter({ hasText: '全部' }).click();
    await sleep(1500);
    const afterExpand = await visibleNodes(page);
    say('按需展开完成（按钮消失）', expandDone);
    say('展开后该章子树渲染', afterExpand > expandBefore, `${expandBefore} → ${afterExpand}`);
    await page.screenshot({ path: '/tmp/v29_expanded.png' });

    // ---- 7 全屏（同一实例换容器，不应重新拉数据：ready 保持且详分支缓存还在） ----
    await page.locator('[data-mm-toolbar] button').filter({ hasText: '放大' }).click();
    let overlay = false;
    for (let i = 0; i < 10 && !overlay; i++) {
        await sleep(300);
        overlay = await page.evaluate(() => Array.from(document.querySelectorAll('h2')).some(h => h.textContent.includes('《' + '非暴力沟通' + '》')));
    }
    say('放大浮层打开', overlay);
    await page.screenshot({ path: '/tmp/v29_overlay.png' });
    await page.locator('button[title="关闭"]').last().click();
    await sleep(500);
    say('放大浮层可关闭', await page.evaluate(() => !Array.from(document.querySelectorAll('h2')).some(h => h.textContent.includes('《非暴力沟通》'))));

    // ---- 8 SVG 导出（事件委托按钮触发 download） ----
    let gotDownload = false;
    try {
        const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 8000 }),
            page.locator('[data-mm-toolbar] button').filter({ hasText: 'SVG' }).click(),
        ]);
        gotDownload = /\.svg$/.test(dl.suggestedFilename());
        say('SVG 导出触发下载', gotDownload, dl.suggestedFilename());
    } catch {
        say('SVG 导出触发下载', false);
    }

    // ---- 9 落盘：新会话含 output_type=mindmap 的 JSON 内容 ----
    let persisted = null;
    for (let i = 0; i < 15 && !persisted; i++) {
        const list = JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId)));
        for (const s of list.sessions) {
            if (baseline.has(s.session_id)) continue;
            const full = JSON.parse(await api('GET', '/sessions/' + s.session_id));
            const t = (full.messages || []).find(m => m.kind === 'tool' && m.output_type === 'mindmap' && (m.content || '').startsWith('{'));
            if (t) persisted = { sid: s.session_id, size: t.content.length, json: JSON.parse(t.content) };
        }
        if (!persisted) await sleep(1000);
    }
    say('导图 JSON 落盘（output_type=mindmap）', !!persisted, persisted ? persisted.size + ' 字' : '');
    say('落盘树章数与界面一致', !!persisted && persisted.json.c.length === mmAttr.chapters, persisted ? String(persisted.json.c.length) : '');

    // ---- 10 追问：结构树摘要进上下文 ----
    const inputSel = 'input[placeholder="输入你的问题..."]';
    await page.waitForSelector(inputSel, { timeout: 20000 });
    await page.fill(inputSel, '上面思维导图里第五章讲什么？一句话。');
    await page.keyboard.press('Enter');
    let answered = false;
    for (let i = 0; i < 90 && !answered; i++) {
        await sleep(1000);
        if (!persisted) continue;
        const full = JSON.parse(await api('GET', '/sessions/' + persisted.sid));
        answered = (full.messages || []).some(m => m.role === 'assistant' && !m.kind && (m.content || '').length > 3);
    }
    say('基于导图的追问可答（摘要进上下文）', answered);

    // ---- 清理（只删本轮新增） ----
    if (persisted) {
        await api('DELETE', '/sessions/' + persisted.sid);
        console.log('  (清理会话', persisted.sid.slice(0, 8), ')');
    } else {
        const list = JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId)));
        for (const s of list.sessions) {
            if (!baseline.has(s.session_id)) { await api('DELETE', '/sessions/' + s.session_id); console.log('  (清理会话', s.session_id.slice(0, 8), ')'); }
        }
    }

    say('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
    await browser.close();
    console.log('\nPASS ' + PASS + '  FAIL ' + FAIL);
    if (FAIL) process.exitCode = 1;
})().catch(async e => {
    console.log('CRASH', e);
    process.exitCode = 2;
    try { if (browser) await browser.close(); } catch { /* 已退出 */ }
});
