// v2.0 浏览器级 E2E：书架 → 搜索 → 进书 → 双栏 → 目录抽屉 → 工具落对话流与落盘 → 刷新恢复 → 追问
// 完成判定一律以后端会话文件持久化状态为准（不依赖肉眼 DOM）
// 运行：node tests/e2e_v20_browser.cjs（需服务已在 127.0.0.1:8000 运行）
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

let browser = null;
(async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    // ---- 1 书架 ----
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
    say('书架标题', await page.locator('h1').filter({ hasText: '书架' }).first().isVisible());
    const covers = await page.evaluate(() =>
        Array.from(document.querySelectorAll('div')).filter(d => (d.getAttribute('style') || '').includes('aspect-ratio')).length);
    say('封面色块 >= 4', covers >= 4, String(covers));
    await page.screenshot({ path: '/tmp/v20_shelf.png' });

    // ---- 2 全局搜索 ----
    await page.fill('input[placeholder="搜书里的内容"]', '怎样倾听他人的需要');
    let gotResults = false;
    for (let i = 0; i < 30 && !gotResults; i++) {
        await sleep(1000);
        gotResults = await page.evaluate(() => /\d+ 处相关段落/.test(document.body.innerText));
    }
    say('语义搜索出结果面板', gotResults);
    await page.screenshot({ path: '/tmp/v20_search.png' });
    await page.fill('input[placeholder="搜书里的内容"]', '');
    await sleep(500);

    // ---- 3 进书 ----
    await page.locator('button').filter({ hasText: '游子吟' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    const bookId = decodeURIComponent(page.url().split('#/book/')[1]);
    say('hash 路由进书', bookId.length > 0, bookId.slice(0, 8));
    // 进书瞬间可能落后一帧渲染，短轮询防 flaky
    let aiVisible = false;
    for (let i = 0; i < 10 && !aiVisible; i++) {
        aiVisible = await page.getByText('AI 助手', { exact: true }).first().isVisible();
        if (!aiVisible) await sleep(200);
    }
    say('AI 区就位', aiVisible);
    let bodyRendered = false;
    for (let i = 0; i < 20 && !bodyRendered; i++) {
        await sleep(1000);
        bodyRendered = await page.evaluate(() => document.body.innerText.replace(/\s/g, '').length > 500);
    }
    say('章节正文渲染', bodyRendered);
    await page.screenshot({ path: '/tmp/v20_reader.png' });

    // ---- 4 收起 AI → 双栏书页 ----
    await page.locator('button[title="AI"]').click();
    await sleep(700);
    say('AI 收起', (await page.getByText('AI 助手', { exact: true }).count()) === 0);
    const colCount = await page.evaluate(() => {
        const el = document.querySelector('.book-columns');
        return el ? getComputedStyle(el).columnCount : 'none';
    });
    say('双栏生效 columnCount=2', colCount === '2', colCount);
    // 真流动检验：右半栏必须落到实际文字（防 break-inside-avoid 巨型块把内容整块挤进第一列）
    const rightFill = await page.evaluate(() => {
        const el = document.querySelector('.book-columns');
        if (!el) return { ok: false, reason: 'no .book-columns' };
        const box = el.getBoundingClientRect();
        const mid = box.x + box.width / 2;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let rightChars = 0, n = 0;
        while (walker.nextNode()) {
            const t = walker.currentNode;
            if (!t.textContent.trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(t);
            let hit = false;
            for (const rb of r.getClientRects()) {
                if (rb.width > 2 && rb.x > mid + 4) { hit = true; break; }
            }
            if (hit) { rightChars += t.textContent.trim().length; n++; }
        }
        return { ok: rightChars > 100, rightChars, rightNodes: n };
    });
    say('双栏右列有文字流动', rightFill.ok, JSON.stringify(rightFill));
    await page.screenshot({ path: '/tmp/v20_twocol.png' });
    await page.locator('button[title="AI"]').click();
    await sleep(400);

    // ---- 5 目录侧栏（v2.1.1：常驻左栏，顶栏开合；1440 视口默认展开） ----
    say('目录侧栏默认展开', await page.evaluate(() => !!document.querySelector('input[placeholder="搜索本书"]')));
    await page.screenshot({ path: '/tmp/v20_toc.png' });
    await page.locator('button[title="目录"]').click();
    await sleep(400);
    say('目录侧栏可收起', await page.evaluate(() => !document.querySelector('input[placeholder="搜索本书"]')));
    await page.locator('button[title="目录"]').click();
    await sleep(400);
    say('目录侧栏可再展开', await page.evaluate(() => !!document.querySelector('input[placeholder="搜索本书"]')));

    // ---- 6 工具抽屉 → 运行 → 对话流卡片 → 后端落盘 ----
    // 进书自动恢复该书最近会话——工具产出会落进 baseline 里的旧会话、轮询永不可见
    // （v2.1 教训只写进了 mindmap 脚本，此处补齐同款隔离：会话抽屉 → 新对话）
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
    // 基线：之前崩溃轮残留的会话一律无视，只认本轮新增（否则残留会话会让落盘断言秒假绿、
    // 且刷新时本轮流式还没结束会被 reload 掐断产生 network error）
    const baseline = new Set(JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId))).sessions.map(s => s.session_id));
    // v3.1：工具入口并入 AI 面板加号级联
    await page.locator('[data-testid="plus-menu"]').click();
    await page.locator('button').filter({ hasText: /^工具$/ }).first().click();
    let toolDrawerOpen = false;
    for (let i = 0; i < 10 && !toolDrawerOpen; i++) {
        await sleep(300);
        toolDrawerOpen = await page.evaluate(() => !!document.querySelector('[data-tool-menu] [data-testid="tool-scope"]'));
    }
    say('工具面板打开', toolDrawerOpen);
    await page.screenshot({ path: '/tmp/v20_tools.png' });
    await page.locator('button[title^="总结"]').first().click();
    // 运行后抽屉自动收起，产出进对话流
    say('运行后工具面板自动收起', await page.evaluate(() => !document.querySelector('[data-tool-menu]')));
    // 落盘信号：该书会话出现 kind=tool 且 content 非空
    let toolMsg = null;
    for (let i = 0; i < 240 && !toolMsg; i++) {
        await sleep(1000);
        const list = JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId)));
        for (const s of list.sessions) {
            if (baseline.has(s.session_id)) continue;
            const full = JSON.parse(await api('GET', '/sessions/' + s.session_id));
            const t = (full.messages || []).find(m => m.kind === 'tool' && (m.content || '').length > 30);
            if (t) { toolMsg = t; }
        }
    }
    say('工具产出落盘（含正文）', !!toolMsg, toolMsg ? String(toolMsg.content.length) + ' 字' : '');
    const cardInFlow = await page.evaluate(() => {
        // 对话流中应出现工具卡（卡头含"总结"且非按钮 title 匹配）
        return Array.from(document.querySelectorAll('span')).some(sp => sp.textContent === '总结' && sp.className.includes('font-semibold'));
    });
    say('对话流中存在工具卡片头', cardInFlow);
    await page.screenshot({ path: '/tmp/v20_toolcard.png' });

    // ---- 6.5 资产区抽屉（顶栏「资产」，v2.4 由收藏升级） ----
    await page.locator('button[title="资产"]').click();
    let favDrawer = false;
    for (let i = 0; i < 10 && !favDrawer; i++) {
        await sleep(300);
        favDrawer = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '资产区'));
    }
    say('资产抽屉打开（带标题）', favDrawer);
    await page.screenshot({ path: '/tmp/v20_fav.png' });
    await page.mouse.click(300, 450); // 背板关闭
    await sleep(400);
    say('资产抽屉可关闭', await page.evaluate(() => !Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '资产区')));

    // ---- 7 刷新恢复（networkidle 在有并发 LLM 流时不收敛，用 load + 轮询兜底） ----
    await page.reload({ waitUntil: 'load' });
    let restored = false;
    for (let i = 0; i < 30 && !restored; i++) {
        await sleep(1000);
        restored = await page.evaluate(() => {
            const ai = document.body.innerText;
            return ai.includes('AI 助手') && ai.includes('总结');
        });
    }
    say('刷新后自动恢复会话与工具卡', restored);

    // ---- 8 追问（工具产出进 history 链路） ----
    const inputSel = 'input[placeholder="输入你的问题..."]';
    await page.waitForSelector(inputSel, { timeout: 20000 });
    await page.fill(inputSel, '一句话回答：上面这份总结的核心结论是什么？');
    await page.keyboard.press('Enter');
    // 完成信号：输入框解禁 + 后端该会话出现第二条 assistant 非空消息
    let answered = false;
    for (let i = 0; i < 120 && !answered; i++) {
        await sleep(1000);
        const list = JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId)));
        for (const s of list.sessions) {
            if (baseline.has(s.session_id)) continue;
            const full = JSON.parse(await api('GET', '/sessions/' + s.session_id));
            const assistants = (full.messages || []).filter(m => m.role === 'assistant' && !m.kind && (m.content || '').length > 3);
            if (assistants.length >= 1 && (full.messages || []).some(m => m.role === 'user' && m.content.includes('核心结论'))) {
                answered = true;
            }
        }
    }
    say('追问完成且落盘', answered);
    await page.screenshot({ path: '/tmp/v20_followup.png' });

    // ---- 清理（只删本轮新增的测试会话，基线内一律不动） ----
    const list = JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId)));
    for (const s of list.sessions) {
        if (baseline.has(s.session_id)) continue;
        await api('DELETE', '/sessions/' + s.session_id);
        console.log('  (清理会话', s.session_id.slice(0, 8), ')');
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
