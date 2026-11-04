// v2.2 句内引用 E2E：真实 LLM 问答 → [n] 角标渲染 → 点击跳原文段落闪烁高亮
// 运行前提：后端服务在 127.0.0.1:8000（dist 已构建）。node tests/e2e_citations.cjs
const { chromium } = require('../frontend/node_modules/playwright');

const BASE = 'http://127.0.0.1:8000';
const BOOK = '非暴力沟通';
const QUESTION = '非暴力沟通认为怎样表达感受才是有效的？请给出依据。';

let PASS = 0, FAIL = 0;
const say = (name, ok, extra = '') => {
    if (ok) { PASS++; console.log(`  ok   ${name} ${extra}`); }
    else { FAIL++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
}

(async () => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

        // ---- 1 进书 + 会话隔离 ----
        await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
        await page.locator('button').filter({ hasText: BOOK }).first().click();
        await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
        const bookId = decodeURIComponent(page.url().split('#/book/')[1]);
        say('进书', bookId.length > 0, bookId.slice(0, 8));

        let settled = false;
        for (let i = 0; i < 20 && !settled; i++) {
            await sleep(1000);
            settled = await page.evaluate(() => !document.body.innerText.includes('章节加载中'));
        }
        say('章节加载有终态', settled);

        const baseline = new Set(JSON.parse((await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId))).data ? JSON.stringify((await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId))).data.sessions.map(s => s.session_id)) : '[]'));
        await page.locator('button[title="会话"]').click();
        await sleep(500);
        await page.locator('button[title="新对话"]').click();
        await sleep(500);
        say('已重置为新对话', await page.evaluate(() => document.body.innerText.includes('暂无对话')));

        // ---- 2 提问并等待回答完成（角标出现=流已收尾且 sources 已到） ----
        await page.locator('input[placeholder*="输入"]').fill(QUESTION);
        await page.keyboard.press('Enter');
        let citeCount = 0;
        for (let i = 0; i < 240 && citeCount === 0; i++) {
            await sleep(1000);
            citeCount = await page.evaluate(() => document.querySelectorAll('.cite-marker').length);
        }
        say('回答句内出现引用角标', citeCount >= 2, 'n=' + citeCount);

        // ---- 3 落盘 sources 带 index/snippet（后端契约） ----
        let newSid = null, assistantMsg = null;
        for (let i = 0; i < 30 && !assistantMsg; i++) {
            await sleep(1000);
            const list = (await api('GET', '/sessions?scope=book&book_id=' + encodeURIComponent(bookId))).data;
            for (const s of (list?.sessions || [])) {
                if (baseline.has(s.session_id)) continue;
                const full = (await api('GET', '/sessions/' + s.session_id)).data;
                const a = (full?.messages || []).filter(m => m.role === 'assistant' && m.sources?.length > 0);
                if (a.length) { newSid = s.session_id; assistantMsg = a[a.length - 1]; break; }
            }
        }
        say('会话落盘含带来源的回答', !!assistantMsg);
        const srcs = assistantMsg?.sources || [];
        const okMeta = srcs.length > 0 && srcs.every(s => Number.isInteger(s.index)) && srcs.some(s => typeof s.snippet === 'string' && s.snippet.length > 0);
        say('sources 带 index 与非空 snippet', okMeta, JSON.stringify(srcs.map(s => [s.index, (s.snippet || '').slice(0, 8)])));

        // 角标编号都在 sources 范围内
        const citeNs = await page.evaluate(() => Array.from(document.querySelectorAll('.cite-marker')).map(b => +b.dataset.cite));
        say('角标编号均对应真实来源', citeNs.every(n => srcs.some(s => s.index === n)), JSON.stringify(citeNs));

        // ---- 4 点角标 → 跳章 → 段落闪烁高亮 ----
        // 选一个带 snippet 且非当前章的角标（优先非首章来源，制造真实跳章）
        const curTitle = await page.evaluate(() => document.querySelector('h2.font-serif-heading')?.textContent?.trim() || '');
        const target = srcs.find(s => s.snippet && s.chapter_title !== curTitle) || srcs.find(s => s.snippet);
        const targetChip = await page.locator(`.cite-marker[data-cite="${target.index}"]`).first();
        await targetChip.click();
        let flashed = false;
        for (let i = 0; i < 20 && !flashed; i++) {
            await sleep(500);
            flashed = await page.evaluate(() => !!document.querySelector('[data-p].cite-flash'));
        }
        say('点击角标后段落高亮出现', flashed);
        const h2After = await page.evaluate(() => document.querySelector('h2.font-serif-heading')?.textContent?.trim() || '');
        say('已跳到角标对应章节', h2After === target.chapter_title.trim(), `${h2After} vs ${target.chapter_title}`);

        // 高亮段落文本包含锚点子串（去空白比较）
        const hit = await page.evaluate(() => {
            const el = document.querySelector('[data-p].cite-flash');
            return el ? el.textContent.replace(/\s+/g, '') : '';
        });
        const norm = s => s.replace(/\s+/g, '');
        say('高亮段落命中来源锚点', target.snippet ? norm(hit).includes(norm(target.snippet)) : true, 'len=' + hit.length);

        await page.screenshot({ path: '/tmp/v22_flash.png' });

        // ---- 5 来源芯片带序号 ----
        say('来源芯片带编号', await page.evaluate(() => !!document.querySelector('[data-source-chip="1"]')));

        // ---- 6 无 JS 报错 & 清理 ----
        say('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
        if (newSid) { await api('DELETE', '/sessions/' + newSid); console.log('  (清理会话', newSid.slice(0, 8), ')'); }

        console.log(`\nPASS ${PASS}  FAIL ${FAIL}`);
        process.exitCode = FAIL ? 1 : 0;
    } catch (e) {
        console.log('CRASH', String(e).slice(0, 400));
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
    }
})();
