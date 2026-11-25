// v3.6 多色高亮 + 笔记浏览器级 E2E（零 LLM）
// 链路：选区→绿色高亮→mark 变色落盘→点 mark 换粉→写笔记（角标出现）→刷新持久→
//       笔记预览行→清空笔记→选区「写笔记」直建（黄底+角标）→取消高亮回基线
// 运行：node tests/e2e_highlights.cjs（需服务在 127.0.0.1:8000；自包含用测试书《非暴力沟通》）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');

const BASE = 'http://127.0.0.1:8000';
let PASS = 0, FAIL = 0;
const say = (name, cond, extra) => {
    if (cond) { PASS++; console.log('  ok  ', name, extra || ''); }
    else { FAIL++; console.log('  FAIL', name, extra || ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function api(method, path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined }, res => {
            let b = '';
            res.on('data', d => (b += d));
            res.on('end', () => {
                if (res.statusCode >= 400) console.log('  HTTP', res.statusCode, method, path, b.slice(0, 120));
                resolve(b);
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// 程序化选中一个干净段落的中间文字（跳过已带 mark 的段落，避免嵌套选区）
const selectInPage = (page, take) => page.evaluate((takeIdx) => {
    const ps = Array.from(document.querySelectorAll('p[data-p], [data-p] p'))
        .filter(p => (p.textContent || '').trim().length >= 40 && !p.querySelector('[data-hl]') && p.firstChild && p.firstChild.nodeType === 3);
    if (ps.length <= takeIdx) return null;
    const p = ps[takeIdx];
    const tn = p.firstChild;
    const start = Math.min(2, Math.max(0, tn.length - 30));
    const range = document.createRange();
    range.setStart(tn, start);
    range.setEnd(tn, Math.min(start + 22, tn.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const text = sel.toString().trim();
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { text };
}, take);

const markState = page => page.evaluate(() => {
    const m = document.querySelector('[data-hl]');
    if (!m) return null;
    return { id: m.dataset.hl, cls: m.className, hasNoteDot: m.className.includes('hl-noted') };
});

let browser = null;
(async () => {
    const books0 = JSON.parse(await api('GET', '/books/list')).books;
    const book = books0.find(b => b.title.includes('非暴力沟通'));
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const bid = book.book_id;
    // 测试书：开跑前清空该书全部划线（上轮崩溃残留会干扰基线与段落选取）
    for (const h of JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).highlights) {
        await api('DELETE', `/highlights/${h.highlight_id}`);
    }
    const baseTotal = 0;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    // ---- 1 进书开章 ----
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    let hasPs = false;
    for (let i = 0; i < 20 && !hasPs; i++) {
        hasPs = await page.evaluate(() => document.querySelectorAll('p[data-p]').length > 3);
        if (!hasPs) {
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button')).filter(b => /^\d+[\.、]/.test(b.textContent.trim()) || /第.+章/.test(b.textContent));
                if (btns.length) btns[0].click();
            });
            await sleep(800);
        }
    }
    say('章节正文就位', hasPs);

    // ---- 2 选区条含四色板 + 写笔记按钮 ----
    const sel1 = await selectInPage(page, 2);
    say('程序化选区成功', !!(sel1 && sel1.text.length > 10), sel1 && sel1.text.slice(0, 14));
    await sleep(300);
    say('选区条浮出且四色齐全', await page.locator('[data-sel-bar]').isVisible() && (await page.locator('[data-sel-bar] [data-sel-hl]').count()) === 4);
    say('写笔记按钮在条上', await page.locator('[data-sel-bar] [data-sel-note]').isVisible());
    await page.screenshot({ path: '/tmp/v36_selbar.png' });

    // ---- 3 点绿色点 → 绿底 mark + 落盘 color=green ----
    await page.locator('[data-sel-bar] [data-sel-hl="green"]').click();
    let st = null;
    for (let i = 0; i < 15 && !(st && st.cls.includes('hl-c-green')); i++) { await sleep(300); st = await markState(page); }
    say('绿色 mark 渲染', !!(st && st.cls.includes('hl-c-green')));
    let hlList = JSON.parse(await api('GET', `/highlights?book_id=${bid}`));
    let entry = hlList.highlights.find(h => h.text === sel1.text);
    say('API 落盘且 color=green', !!entry && entry.color === 'green');
    const hid = entry && entry.highlight_id;

    // ---- 4 点 mark → 菜单 → 换粉 ----
    await page.locator(`[data-hl="${hid}"]`).click();
    await sleep(300);
    say('划线菜单浮出且四色齐全', await page.locator('[data-hl-menu]').isVisible() && (await page.locator('[data-hl-menu] [data-hl-color]').count()) === 4);
    await page.locator('[data-hl-menu] [data-hl-color="pink"]').click();
    for (let i = 0; i < 12; i++) { await sleep(250); st = await markState(page); if (st && st.cls.includes('hl-c-pink')) break; }
    say('换粉即时生效', !!(st && st.cls.includes('hl-c-pink')));
    entry = JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).highlights.find(h => h.highlight_id === hid);
    say('API 颜色同步为 pink', !!entry && entry.color === 'pink');

    // ---- 5 菜单「笔记」→ 弹层输入 → 保存 ----
    await page.locator(`[data-hl="${hid}"]`).click();
    await sleep(250);
    await page.locator('[data-hl-menu] [data-hl-note]').click();
    await sleep(250);
    say('笔记弹层浮出', await page.locator('[data-note-box]').isVisible());
    const NOTE = '这段配周三团契';
    await page.locator('[data-note-input]').fill(NOTE);
    await page.locator('[data-note-save]').click();
    for (let i = 0; i < 12; i++) { await sleep(250); st = await markState(page); if (st && st.hasNoteDot) break; }
    say('笔记角标出现', !!(st && st.hasNoteDot));
    entry = JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).highlights.find(h => h.highlight_id === hid);
    say('API 笔记落盘', !!entry && entry.note === NOTE);
    await page.screenshot({ path: '/tmp/v36_noted.png' });

    // ---- 6 刷新持久 + 笔记预览行 ----
    await page.reload({ waitUntil: 'networkidle' });
    let back = null;
    for (let i = 0; i < 25 && !(back && back.hasNoteDot); i++) { await sleep(400); back = await markState(page); }
    say('刷新后笔记与颜色仍在', !!(back && back.hasNoteDot && back.cls.includes('hl-c-pink')));
    await page.locator(`[data-hl="${hid}"]`).click();
    await sleep(300);
    const preview = await page.locator('[data-hl-note-view]').innerText().catch(() => '');
    say('菜单内笔记预览行', preview.includes(NOTE), preview.slice(0, 24));
    await page.screenshot({ path: '/tmp/v36_preview.png' });

    // ---- 7 编辑弹层里清空笔记 ----
    await page.locator('[data-hl-note-view]').click();
    await sleep(250);
    await page.locator('[data-note-clear]').click();
    for (let i = 0; i < 12; i++) { await sleep(250); st = await markState(page); if (st && !st.hasNoteDot) break; }
    say('清空后角标消失、高亮保留', !!(st && !st.hasNoteDot && st.cls.includes('hl-c-pink')));
    entry = JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).highlights.find(h => h.highlight_id === hid);
    say('API 笔记已清', !!entry && !entry.note);

    // ---- 8 选区「写笔记」直建（高亮+笔记一体，默认黄）----
    const sel2 = await selectInPage(page, 4);
    await sleep(300);
    await page.locator('[data-sel-bar] [data-sel-note]').click();
    await sleep(250);
    const NOTE2 = '笔记直建测试';
    await page.locator('[data-note-input]').fill(NOTE2);
    await page.locator('[data-note-save]').click();
    await sleep(700);
    hlList = JSON.parse(await api('GET', `/highlights?book_id=${bid}`));
    const direct = hlList.highlights.find(h => h.text === sel2.text && h.note === NOTE2);
    say('选区直建高亮+笔记', !!direct && direct.color === 'amber', direct && direct.color);

    // ---- 9 取消两条测试高亮回基线 ----
    for (const id of [hid, direct && direct.highlight_id]) {
        if (id) await api('DELETE', `/highlights/${id}`);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(800);
    const leftTotal = JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).total;
    say('清理后回到基线', leftTotal === baseTotal);

    const realErrs = errors.filter(e => !/favicon|ERR_FAILED|WebSocket|net::ERR/.test(e));
    say('无 JS 报错', realErrs.length === 0, realErrs.slice(0, 2).join(' | ').slice(0, 160));

    console.log(`\nv3.6 highlights E2E: ${PASS} passed, ${FAIL} failed`);
    await browser.close();
    process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('E2E 崩溃:', e); if (browser) browser.close(); process.exit(1); });
