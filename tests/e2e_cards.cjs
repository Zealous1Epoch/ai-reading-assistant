// v2.3 知识卡片浏览器级 E2E：书架复习入口 → 翻卡评分 → 书内抽卡（真实 LLM）→ 卡片抽屉（计数/列表/删卡/Anki 链接）→ 清理
// 运行：node tests/e2e_cards.cjs（需服务在 127.0.0.1:8000；抽卡走真实 LLM，预留数分钟）
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
    // 基线：冒烟已在本书造过若干卡（第三章 8 张）。本轮 E2E 只清自己产生的增量。
    const books0 = JSON.parse(await api('GET', '/books/list')).books;
    const book = books0.find(b => b.title.includes('非暴力沟通'));
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const bid = book.book_id;
    const ch4 = (book.chapters || []).find(c => c.title.includes('第四章'));
    const cardsBefore0 = JSON.parse(await api('GET', '/cards?book_id=' + bid)).cards;
    // 清掉上轮可能残留的第四章卡（保证本轮抽卡必出新卡）
    for (const c of cardsBefore0) {
        if ((c.chapter_title || '').includes('第四章')) await api('DELETE', '/cards/' + c.card_id);
    }
    const cardsBefore = new Set(JSON.parse(await api('GET', '/cards?book_id=' + bid)).cards.map(c => c.card_id));
    const sessBefore = new Set((JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + bid)).sessions || []).map(s => s.session_id));

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    // ---- 1 书架复习入口 + 路由（翻卡评分挪到抽卡之后：本套件自包含，不再依赖冒烟种子卡） ----
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
    say('书架复习按钮存在', await page.locator('[data-open-review]').isVisible());
    await page.locator('[data-open-review]').click();
    await page.waitForFunction(() => location.hash === '#/review', null, { timeout: 8000 });
    say('进入复习页路由', true);

    // ---- 2 进书抽卡（选第四章：未抽过，保证出新卡） ----
    await page.goto(BASE + '/#/', { waitUntil: 'load' });
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    await page.locator('button[title="会话"]').click();
    await page.locator('button[title="新对话"]').click();
    await sleep(600);
    // 目录选第四章（避开冒烟抽过的第三章与无内容的孤章首章），以章头确认真切换
    if (ch4) {
        await page.locator('div[data-toc]').filter({ hasText: '第四章' }).first().click();
        await page.waitForFunction(() => {
            const h = document.querySelector('h2.font-serif-heading');
            return h && h.innerText.includes('第四章');
        }, null, { timeout: 10000 });
        say('目录点章切换成功（章头确认）', true);
    }
    // v3.1：工具入口并入 AI 面板 ➕ 级联
    await page.locator('[data-testid="plus-menu"]').click();
    await page.locator('button').filter({ hasText: /^工具$/ }).first().click();
    await page.waitForSelector('[data-tool-menu] [data-testid="tool-scope"]', { timeout: 5000 });
    // 点工具行即运行；范围默认=当前章
    await page.locator('button').filter({ hasText: '知识卡片' }).first().click();
    await sleep(800);
    say('运行后工具抽屉自动收起', await page.locator('[data-testid="tool-scope"]').isVisible().catch(() => false) === false);
    let cardsOk = false;
    for (let i = 0; i < 90 && !cardsOk; i++) {
        await sleep(2000);
        cardsOk = await page.evaluate(() => document.querySelectorAll('[data-card-front]').length >= 3);
    }
    say('对话流工具卡渲染卡片预览 ≥3 张', cardsOk);
    const cardsAfterRun = JSON.parse(await api('GET', '/cards?book_id=' + bid)).cards;
    const newOnes = cardsAfterRun.filter(c => !cardsBefore.has(c.card_id));
    say('新卡已入库（API 侧确认）', newOnes.length >= 3, 'new=' + newOnes.length);
    say('新卡归属所选章节', !!ch4 && newOnes.every(c => (c.chapter_title || '').includes('第四章')),
        newOnes[0] ? newOnes[0].chapter_title : '');

    // ---- 2.5 复习页翻卡评分（新卡当天到期 → 此刻全局队列必有卡，套件自包含） ----
    await page.goto(BASE + '/#/review', { waitUntil: 'load' });
    const hasCard = await page.waitForSelector('[data-review-card]', { timeout: 10000 }).catch(() => null);
    say('到期队列渲染出卡片', !!hasCard);
    if (hasCard) {
        const front0 = (await page.locator('[data-review-front]').innerText()).trim();
        await page.locator('[data-review-card]').click();           // 点卡翻面
        await page.waitForSelector('[data-review-back]', { timeout: 3000 });
        const back0 = await page.locator('[data-review-back]').innerText();
        say('翻卡见正面问题与背面答案', front0.length > 3 && back0.length > 3);
        await page.getByRole('button', { name: /记住了/ }).click();  // 评分 good
        await sleep(500);
        const prog = await page.locator('[data-review-progress]').innerText().catch(() => '');
        say('评分后推进下一张', /2\s*\/\s*\d+/.test(prog), prog);
        // 全局队列首位不一定是本书卡（跨书残留会抢位）→ 全量查卡校验评分落盘
        const allCards = JSON.parse(await api('GET', '/cards')).cards;
        const graded = allCards.find(c => c.front === front0);
        say('评分落盘 box=2', !!(graded && graded.box === 2));
    }

    // ---- 3 书内卡片抽屉（复习页是全屏路由，先回书内） ----
    await page.goto(BASE + '/#/', { waitUntil: 'load' });
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    await page.locator('button[title="卡片"]').click();
    await page.waitForSelector('[data-cards-count]', { timeout: 5000 });
    const cntTxt = (await page.locator('[data-cards-count]').innerText()).replace(/\D/g, '');
    say('卡片抽屉打开且计数与 API 一致', String(cardsAfterRun.length) === cntTxt, `drawer=${cntTxt} api=${cardsAfterRun.length}`);
    say('导出 Anki 链接存在', await page.locator('[data-cards-export="anki"]').isVisible());
    await page.locator('[data-cards-tab="list"]').click();
    await sleep(800);
    const listVisible = await page.evaluate(() => {
        const rows = document.querySelectorAll('.group.rounded-xl');
        return rows.length >= 3 && /复习/.test(document.body.innerText);
    });
    say('列表视图渲染卡片行', listVisible);
    const delBtn = page.locator('button[title="删除卡片"]').first();
    await delBtn.click();
    // refreshStats 是异步的：短轮询等计数真正下降（≤8s），再断言精确值
    let cntAfterDel = cntTxt;
    for (let i = 0; i < 40; i++) {
        cntAfterDel = (await page.locator('[data-cards-count]').innerText()).replace(/\D/g, '');
        if (cntAfterDel && Number(cntAfterDel) < Number(cntTxt)) break;
        await sleep(200);
    }
    say('删卡生效（计数-1）', cntAfterDel === String(Number(cntTxt) - 1), `${cntTxt}→${cntAfterDel}`);

    // ---- 4 无 JS 报错 ----
    say('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close().catch(() => {});
    browser = null;

    // ---- 清理：本轮新会话 + 本轮新增卡片（恢复冒烟后状态） ----
    const sessNow = JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + bid)).sessions || [];
    for (const s of sessNow.filter(x => !sessBefore.has(x.session_id))) {
        await api('DELETE', '/sessions/' + s.session_id);
        console.log('  (清理会话 ' + s.session_id.slice(0, 8) + ')');
    }
    let deleted = 0;
    for (const c of (await JSON.parse(await api('GET', '/cards?book_id=' + bid)).cards)) {
        if (!cardsBefore.has(c.card_id)) { await api('DELETE', '/cards/' + c.card_id); deleted++; }
    }
    console.log('  (清理卡片 ' + deleted + ' 张)');

    console.log(`\nPASS ${PASS}  FAIL ${FAIL}`);
    process.exit(FAIL ? 1 : 0);
})().catch(async e => {
    console.error('CRASH', e);
    if (browser) await browser.close().catch(() => {});
    process.exit(2);
});
