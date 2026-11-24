// v3.4 逐题引导浏览器 E2E：十问（单章范围）出题→作答→抢跑被拦→小结→下一题→关层续跑；导读软推进；API 侧落盘核对；清理
// 运行：node tests/e2e_guides.cjs（需服务在 127.0.0.1:8000；出题/讲评/小结走真实 LLM，预留 3-6 分钟）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');

const BASE = 'http://127.0.0.1:8000';
let PASS = 0, FAIL = 0;
const say = (name, cond, extra = '') => {
    if (cond) { PASS++; console.log('  ok  ', name, extra); }
    else { FAIL++; console.log('  FAIL', name, extra); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

let browser = null;
(async () => {
    const books0 = JSON.parse(await api('GET', '/books/list')).books;
    const book = books0.find(b => (b.title || '').includes('诸神的面具'));
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const bid = book.book_id;
    // 清场：本书历史引导会话一律删掉，保证本轮必出新卷
    for (const g of (JSON.parse(await api('GET', '/guides?book_id=' + bid)).guides || [])) {
        await api('DELETE', '/guides/' + g.guide_id);
    }

    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    const openToolMenu = async () => {
        await page.locator('[data-testid="plus-menu"]').click();
        await page.locator('button').filter({ hasText: /^工具$/ }).first().click();
        await page.waitForSelector('[data-tool-menu]', { timeout: 8000 });
    };

    // ---- 1 进书 ----
    await page.goto(BASE + '/#/', { waitUntil: 'load' });
    await page.locator('button').filter({ hasText: '诸神的面具' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 15000 });
    say('进入书内', true);

    // ---- 2 十问（当前章范围，出题更快）----
    await openToolMenu();
    await page.locator('[data-testid="tool-scope"] button').first().click(); // 当前章
    await page.locator('button[title^="读书十问"]').first().click();
    say('点十问后工具弹层收起', await page.evaluate(() => !document.querySelector('[data-tool-menu]')));
    say('引导浮层出现', await page.waitForSelector('[data-guide-overlay]', { timeout: 8000 }).then(() => true).catch(() => false));
    const qReady = await page.waitForSelector('[data-guide-question]', { timeout: 240000 }).then(() => true).catch(() => false);
    say('十问出题渲染题面', qReady);
    if (!qReady) { console.log('generation timeout, abort'); await browser.close(); process.exit(1); }
    const prog1 = await page.locator('[data-guide-progress]').innerText().catch(() => '');
    say('进度显示第1题(共>=8题)', /第\s*1\s*\/\s*([89]|10)\s*题/.test(prog1), prog1);
    say('未作答时「下一题」禁用', await page.locator('[data-guide-next]').isDisabled());
    say('未作答时「小结」禁用', await page.locator('[data-guide-summarize]').isDisabled());
    await page.screenshot({ path: '/tmp/guide_q1.png' });

    // ---- 3 作答 → 教练讲评 ----
    const myAns = '我认为这一章讲的核心是：我们最爱的好东西一旦坐上了生命首位，就会反过来奴役我们。';
    await page.fill('[data-guide-answer]', myAns);
    await page.click('[data-guide-send]');
    await page.waitForFunction(() => {
        const b = document.querySelector('[data-guide-summarize]');
        return b && !b.disabled;
    }, null, { timeout: 240000 });
    const threadTxt = await page.locator('[data-guide-overlay]').innerText();
    say('读者回答上屏', threadTxt.includes('奴役我们'));
    say('教练讲评气泡出现', threadTxt.includes('教练'));
    await page.screenshot({ path: '/tmp/guide_reply.png' });

    // ---- 4 抢跑被拦（后端 409）+ 小结解锁下一题 ----
    await page.fill('[data-guide-answer]', '再补一句：就像书里说的，愿望成真反而成了审判。');
    await page.click('[data-guide-send]');
    await page.waitForFunction(() => {
        const b = document.querySelector('[data-guide-summarize]');
        return b && !b.disabled;
    }, null, { timeout: 240000 });
    say('多轮作答后小结仍可点', await page.locator('[data-guide-summarize]').isEnabled());
    say('未出小结时「下一题」仍禁用', await page.locator('[data-guide-next]').isDisabled());
    await page.click('[data-guide-summarize]');
    await page.waitForFunction(() => document.body.innerText.includes('本题小结'), null, { timeout: 240000 });
    say('本题小结气泡出现', true);
    await page.waitForFunction(() => {
        const b = document.querySelector('[data-guide-next]');
        return b && !b.disabled;
    }, null, { timeout: 20000 });
    say('小结后「下一题」解锁', true);
    await page.screenshot({ path: '/tmp/guide_summary.png' });

    await page.click('[data-guide-next]');
    await page.waitForFunction(() => /第\s*2\s*\//.test(document.body.innerText), null, { timeout: 15000 });
    say('推进到第2题', true);

    // API 侧核对：strict 门禁字段
    const gs = JSON.parse(await api('GET', '/guides?book_id=' + bid + '&status=in_progress')).guides;
    const gq = gs.find(g => g.kind === 'questions');
    say('十问会话落库(kind/strict)', !!gq && gq.strict === true);
    if (gq) {
        const full = JSON.parse(await api('GET', '/guides/' + gq.guide_id)).guide;
        say('per_q[0] 两轮作答+小结resolved', (full.per_q[0].turns.filter(t => t.role === 'reader').length === 2) && !!full.per_q[0].summary && full.per_q[0].resolved === true);
        say('current_index=1', full.current_index === 1);
    }

    // ---- 5 关层再开：断点续跑（应直接回到第2题，不重新出卷）----
    await page.locator('[data-guide-overlay] button[title="关闭"]').click();
    say('浮层可关闭回书页', await page.evaluate(() => !document.querySelector('[data-guide-overlay]')));
    await openToolMenu();
    await page.locator('button[title^="读书十问"]').first().click();
    await page.waitForFunction(() => /第\s*2\s*\/\s*\d+\s*题/.test(document.body.innerText), null, { timeout: 20000 });
    say('重开自动续跑到第2题(未重新出卷)', true);
    await page.locator('[data-guide-overlay] button[title="关闭"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-guide-overlay]'), null, { timeout: 5000 });

    // ---- 6 导读（软模式）：不答也能翻下一题 ----
    await openToolMenu();
    await page.locator('button[title^="总结"]').first().click();
    const lReady = await page.waitForSelector('[data-guide-question]', { timeout: 240000 }).then(() => true).catch(() => false);
    say('导读单出题渲染题面', lReady);
    if (lReady) {
        say('导读未作答「下一题」直接可用', await page.locator('[data-guide-next]').isEnabled());
        await page.click('[data-guide-next]');
        await page.waitForFunction(() => /第\s*2\s*\//.test(document.body.innerText), null, { timeout: 15000 });
        say('导读软推进到第2条', true);
        await page.screenshot({ path: '/tmp/guide_lead.png' });
    }

    // ---- 7 页面零报错 + 清理 ----
    say('浏览器无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
    for (const g of (JSON.parse(await api('GET', '/guides?book_id=' + bid)).guides || [])) {
        await api('DELETE', '/guides/' + g.guide_id);
    }
    const left = JSON.parse(await api('GET', '/guides?book_id=' + bid)).guides;
    say('测试会话已清理', left.length === 0, 'left=' + left.length);

    await browser.close();
    console.log(`\n===== ${PASS} PASS / ${FAIL} FAIL =====`);
    process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('E2E_CRASH', e); if (browser) await browser.close(); process.exit(1); });
