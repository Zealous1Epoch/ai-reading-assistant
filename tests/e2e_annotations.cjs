// v3.7 批注抽屉 + Obsidian 导出浏览器级 E2E（零 LLM）
// 链路：API 注入三色高亮（两章，其一真实正文段）→ 顶栏批注徽标 → 抽屉分组/色筛/笔记筛 →
//       点条跳章+cite-flash → 悬停删条 → 导出 MD 落 /tmp（settings 临时改目录）→ 内容断言 → 全清理
// 运行：node tests/e2e_annotations.cjs（需服务在 127.0.0.1:8000；测试书《非暴力沟通》）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8000';
const E2E_DIR = '/tmp/rdb_e2e';   // 导出目录临时覆盖，绝不打进真 vault
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

let browser = null;
(async () => {
    const books0 = JSON.parse(await api('GET', '/books/list')).books;
    const book = books0.find(b => b.title.includes('非暴力沟通'));
    if (!book || !book.chapters || book.chapters.length < 2) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const bid = book.book_id;
    const [ch0, ch1] = book.chapters;

    // ---- 0 清残留 + 导出目录指去 /tmp ----
    for (const h of JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).highlights) {
        await api('DELETE', `/highlights/${h.highlight_id}`);
    }
    await api('PUT', '/api/settings/export', { obsidian_dir: E2E_DIR });
    if (fs.existsSync(E2E_DIR)) fs.rmSync(E2E_DIR, { recursive: true });

    // ---- 1 注入三色高亮；ch1 那条取真实正文子串，供跳原文 cite-flash 命中 ----
    const chapContent = JSON.parse(await api('GET', `/books/chapters/${ch1.chapter_id}`)).content || '';
    const m = chapContent.match(/[\u4e00-\u9fa5，。；：！？\u201c\u201d]{20,}/);
    const realText = m ? m[0].slice(0, 30) : '';
    if (!realText) { console.log('NO_REAL_TEXT'); process.exit(1); }
    await api('POST', '/highlights', { book_id: bid, chapter_id: ch0.chapter_id, start_p: 0, text: 'E2E甲句观察而不评判', color: 'green' });
    await api('POST', '/highlights', { book_id: bid, chapter_id: ch0.chapter_id, start_p: 1, text: 'E2E乙句感受需要', color: 'amber', note: 'E2E笔记甲' });
    await api('POST', '/highlights', { book_id: bid, chapter_id: ch1.chapter_id, start_p: 0, text: realText, color: 'pink', note: 'E2E笔记乙' });

    // ---- 2 进书 → 批注徽标=3 → 抽屉分组 ----
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m2 => { if (m2.type() === 'error' && !/Failed to load resource/.test(m2.text())) errors.push(m2.text()); });
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });

    const annBtn = page.locator('button[title="批注"]');
    await page.waitForFunction(() => {
        const b = document.querySelector('button[title="批注"]');
        return b && b.textContent.includes('3');
    }, null, { timeout: 10000 });
    say('顶栏批注徽标计数=3', true);
    await annBtn.click();
    await sleep(400);
    say('抽屉打开且头部计数 3', (await page.locator('[data-ann-count]').innerText()).includes('3'));
    const groups = await page.locator('[data-ann-group]').count();
    say('按章分组=2', groups === 2, String(groups));
    const items0 = await page.locator('[data-ann-item]').count();
    say('全量条目=3', items0 === 3);
    await page.screenshot({ path: '/tmp/v37_drawer.png' });

    // ---- 3 色筛 + 只看有笔记 ----
    await page.locator('[data-ann-filter="green"]').click();
    await sleep(200);
    say('绿筛只剩 1 条', (await page.locator('[data-ann-item]').count()) === 1);
    await page.locator('[data-ann-filter="all"]').click();
    await page.locator('[data-ann-filter-noted]').click();
    await sleep(200);
    say('只看有笔记=2 条', (await page.locator('[data-ann-item]').count()) === 2);
    await page.locator('[data-ann-filter-noted]').click();
    await page.locator('[data-ann-filter="all"]').click();
    await sleep(200);

    // ---- 4 点 ch1 条目 → 抽屉关、章切换、cite-flash 命中 ----
    const pinkItem = page.locator('[data-ann-item]').filter({ hasText: realText.slice(0, 10) }).first();
    await pinkItem.click();
    await sleep(600);
    say('跳原文后抽屉收起', (await page.locator('[data-ann-count]').count()) === 0);
    const jumped = await page.evaluate((t) => {
        const h2 = document.querySelector('h2.reader-title, h2');
        const flash = document.querySelector('.cite-flash');
        return { flash: !!flash, title: h2 ? h2.textContent : '' };
    }, realText);
    say('章头切到目标章', jumped.title.includes(ch1.title), jumped.title.slice(0, 20));
    say('cite-flash 段落闪烁命中', jumped.flash);
    await page.screenshot({ path: '/tmp/v37_jump.png' });

    // ---- 5 抽屉里删一条（ch0 无笔记的绿条）----
    await page.locator('button[title="批注"]').click();
    await sleep(300);
    await page.locator('[data-ann-filter="green"]').click();
    await sleep(200);
    const greenId = await page.locator('[data-ann-item]').first().getAttribute('data-ann-item');
    await page.locator(`[data-ann-remove="${greenId}"]`).click();
    await sleep(500);
    say('绿筛清空（删的就是绿条）', (await page.locator('[data-ann-item]').count()) === 0);
    const restAll = await (async () => { await page.locator('[data-ann-filter="all"]').click(); await sleep(250); return page.locator('[data-ann-item]').count(); })();
    say('全筛下剩 2 条', restAll === 2);
    const apiTotal = JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).total;
    say('API 同步删除', apiTotal === 2);

    // ---- 6 导出 MD：成功条 + 文件内容 ----
    await page.locator('[data-ann-export]').click();
    let msg = '';
    for (let i = 0; i < 15 && !msg; i++) { await sleep(300); msg = await page.locator('[data-ann-export-msg]').innerText().catch(() => ''); }
    say('导出结果条含目标目录', msg.includes('rdb_e2e'), msg.slice(0, 60));
    await page.screenshot({ path: '/tmp/v37_export.png' });
    const files = fs.existsSync(E2E_DIR) ? fs.readdirSync(E2E_DIR) : [];
    say('vault 目录落文件', files.length === 1 && files[0].endsWith('.md'), JSON.stringify(files));
    if (files.length) {
        const md = fs.readFileSync(E2E_DIR + '/' + files[0], 'utf-8');
        const checks = [
            ['frontmatter tags', md.includes('tags: [读点书吧]')],
            ['章节标题', md.includes('## ' + ch1.title)],
            ['高亮原文', md.includes(realText.slice(0, 12))],
            ['笔记行', md.includes('✎ E2E笔记乙') && md.includes('✎ E2E笔记甲')],
            ['颜色分节', md.includes('**🟡 重要**') && md.includes('**🩷 不认同**')],
            ['计数', md.includes('highlights: 2') && md.includes('notes: 2')],
        ];
        for (const [n, c] of checks) say('MD ' + n, c);
    }

    // ---- 7 清理：设置目录恢复默认、删光测试高亮、删 /tmp 目录 ----
    await api('PUT', '/api/settings/export', { obsidian_dir: '' });
    for (const h of JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).highlights) {
        await api('DELETE', `/highlights/${h.highlight_id}`);
    }
    fs.rmSync(E2E_DIR, { recursive: true, force: true });
    const left = JSON.parse(await api('GET', `/highlights?book_id=${bid}`)).total;
    say('清理回基线 0', left === 0);
    const realErrs = errors.filter(e => !/favicon|ERR_FAILED|WebSocket|net::ERR/.test(e));
    say('无 JS 报错', realErrs.length === 0, realErrs.slice(0, 2).join(' | ').slice(0, 160));

    console.log(`\nv3.7 annotations E2E: ${PASS} passed, ${FAIL} failed`);
    await browser.close();
    process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('E2E 崩溃:', e); if (browser) browser.close(); process.exit(1); });
