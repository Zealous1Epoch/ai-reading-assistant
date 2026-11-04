// v2.7 浏览器级 E2E：选中高亮全链路（零 LLM）
// 划线持久化 → 刷新不丢 → 点划线取消 → 选区送对话 chip → 存量会话 quote 消息渲染
// 运行：node tests/e2e_selection.cjs（需服务已在 127.0.0.1:8000 运行）
// 结束自清理：删掉本轮产生的全部划线与测试会话，不留污染
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
        const req = http.request(BASE + path, { method, headers: { 'Content-Type': 'application/json' } }, res => {
            let b = '';
            res.on('data', d => (b += d));
            res.on('end', () => {
                // 状态码诊断：非 2xx 时打印响应体，防止 JSON.parse 出 undefined 静默续跑
                if (res.statusCode >= 400) console.log('  HTTP', res.statusCode, method, path, b.slice(0, 120));
                resolve(b);
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// 程序化选中第 n 个足长段落的中间一段文字并触发 mouseup
const selectInPage = (page, take) => page.evaluate((takeIdx) => {
    const ps = Array.from(document.querySelectorAll('p[data-p]')).filter(p => (p.textContent || '').trim().length >= 40);
    if (ps.length <= takeIdx) return null;
    const p = ps[takeIdx];
    const tn = p.firstChild && p.firstChild.nodeType === 3 ? p.firstChild : null;
    if (!tn) return null;
    const start = Math.min(2, Math.max(0, tn.length - 30));
    const range = document.createRange();
    range.setStart(tn, start);
    range.setEnd(tn, Math.min(start + 24, tn.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const text = sel.toString().trim();
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { text, pIndex: p.dataset.p };
}, take);

let browser = null;
(async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    // ---- 1 进书并打开一章 ----
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
    await page.locator('button').filter({ hasText: '游子吟' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    const bookId = decodeURIComponent(page.url().split('#/book/')[1]);
    // 等正文叶子段落就位（进度恢复或需要手动选章）
    let hasPs = false;
    for (let i = 0; i < 20 && !hasPs; i++) {
        hasPs = await page.evaluate(() => document.querySelectorAll('p[data-p]').length > 3);
        if (!hasPs) {
            // 兜底：点目录里第一个章节按钮
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button')).filter(b => /^\d+[\.、]/.test(b.textContent.trim()) || /第.+章/.test(b.textContent));
                if (btns.length) btns[0].click();
            });
            await sleep(800);
        }
    }
    say('章节正文就位', hasPs);

    // 基线：进书前该书划线数
    const baseTotal = JSON.parse(await api('GET', `/highlights?book_id=${bookId}`)).total;

    // ---- 2 选区 → 操作条 ----
    const selInfo = await selectInPage(page, 2);
    say('程序化选区成功', !!(selInfo && selInfo.text.length > 10), selInfo && selInfo.text.slice(0, 16));
    await sleep(300);
    say('选区操作条浮出', await page.locator('[data-sel-bar]').isVisible());
    await page.screenshot({ path: '/tmp/v27_selbar.png' });

    // ---- 3 划线：mark 出现 + API 对账 ----
    await page.locator('[data-sel-bar] [data-sel-hl]').click();
    let markOk = false;
    for (let i = 0; i < 15 && !markOk; i++) {
        await sleep(300);
        markOk = await page.evaluate(() => document.querySelectorAll('[data-hl]').length >= 1);
    }
    say('划线 mark 渲染', markOk);
    const marks = await page.evaluate(() => Array.from(document.querySelectorAll('[data-hl]')).map(m => m.textContent));
    say('mark 文本与选区一致', marks.some(t => t === selInfo.text), JSON.stringify(marks[0] || '').slice(0, 30));
    let hlList = JSON.parse(await api('GET', `/highlights?book_id=${bookId}`));
    say('API 划线落盘', hlList.total === baseTotal + 1 && hlList.highlights.some(h => h.text === selInfo.text));

    // ---- 4 刷新持久化 ----
    await page.reload({ waitUntil: 'networkidle' });
    let markAfterReload = false;
    for (let i = 0; i < 25 && !markAfterReload; i++) {
        await sleep(400);
        markAfterReload = await page.evaluate(() => document.querySelectorAll('[data-hl]').length >= 1);
    }
    say('刷新后划线仍在', markAfterReload);

    // ---- 5 点 mark → 取消划线 ----
    await page.locator('[data-hl]').first().click();
    await sleep(300);
    say('划线菜单浮出', await page.locator('[data-hl-menu]').isVisible());
    await page.locator('[data-hl-menu] [data-hl-remove]').click();
    await sleep(500);
    say('取消后 mark 消失', (await page.locator('[data-hl]').count()) === 0);
    hlList = JSON.parse(await api('GET', `/highlights?book_id=${bookId}`));
    say('API 划线同步删除', hlList.total === baseTotal);

    // ---- 6 加入对话：chip ----
    const sel2 = await selectInPage(page, 3);
    await sleep(300);
    say('二次选区操作条', await page.locator('[data-sel-bar]').isVisible());
    await page.locator('[data-sel-bar] [data-sel-quote]').click();
    await sleep(300);
    const chipText = await page.locator('[data-quote-chip]').innerText().catch(() => '');
    say('引用 chip 出现且含选区文本', chipText.includes(sel2.text.slice(0, 10)), chipText.slice(0, 24));
    await page.screenshot({ path: '/tmp/v27_chip.png' });
    await page.locator('[data-quote-clear]').click();
    await sleep(200);
    say('chip 可移除', (await page.locator('[data-quote-chip]').count()) === 0);

    // ---- 7 存量会话带 quote 的消息渲染（API 注入，零 LLM）----
    const MARK = 'E2E引用渲染断言' + Date.now();
    const sid = JSON.parse(await api('POST', '/sessions', { book_id: bookId, scope: 'book' })).session_id;
    await api('POST', `/sessions/${sid}/messages`, {
        role: 'user', content: MARK,
        quote: { text: sel2.text, chapter_id: 'e2e-fake-chapter', chapter_title: '第三章' },
    });
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(800);
    await page.locator('button').filter({ hasText: '会话' }).first().click();
    await sleep(500);
    // 会话条目 = div.group（点击整行切换，非 button）
    await page.locator('div.group').filter({ hasText: MARK }).first().click();
    await sleep(600);
    const quoteBox = await page.locator('[data-msg-quote]').innerText().catch(() => '');
    say('气泡引用块渲染', quoteBox.includes(sel2.text.slice(0, 10)) && quoteBox.includes('第三章'), quoteBox.slice(0, 30));
    const bodyHasMark = await page.evaluate((m) => document.body.innerText.includes(m), MARK);
    say('气泡问题正文渲染', bodyHasMark);
    await page.screenshot({ path: '/tmp/v27_msgquote.png' });

    // ---- 清理 + JS 错误检查 ----
    await api('DELETE', `/sessions/${sid}`);
    const left = JSON.parse(await api('GET', `/highlights?book_id=${bookId}`));
    say('清理后划线回到基线', left.total === baseTotal);
    const realErrs = errors.filter(e => !/favicon|ERR_FAILED.*audio|WebSocket|net::ERR/.test(e));
    say('无 JS 报错', realErrs.length === 0, realErrs.slice(0, 2).join(' | ').slice(0, 160));

    console.log(`\nv2.7 selection E2E: ${PASS} passed, ${FAIL} failed`);
    await browser.close();
    process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('E2E 崩溃:', e); if (browser) browser.close(); process.exit(1); });
