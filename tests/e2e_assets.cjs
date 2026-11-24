// v2.4 资产区浏览器级 E2E（零 LLM 设计：注入数据全走 API，DeepSeek 欠费也能跑）
// 链路：API 注入 3 资产 + 1 假会话(工具产出+收束报告) → localStorage 预置旧收藏 →
//       进书(自动恢复注入会话) → 迁移落库+旧key清除 → 抽屉计数/筛选/搜索 →
//       导图重放/HTML 预览 → 工具卡收藏/报告归档/取消 → 移除资产 → 导出MD → 清理
// 运行：node tests/e2e_assets.cjs（需服务在 127.0.0.1:8000）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');

const BASE = 'http://127.0.0.1:8000';
let PASS = 0, FAIL = 0;
const say = (name, cond, extra = '') => {
    if (cond) { PASS++; console.log('  ok  ', name, extra); }
    else { FAIL++; console.log('  FAIL', name, extra); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function api(method, path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE + path, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
        }, res => {
            let b = '';
            res.on('data', d => (b += d));
            res.on('end', () => resolve(b));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// 所有本轮数据（含迁移与收藏产物）都带 E2E 字样，据此对账与清理
const hasE2E = a => JSON.stringify(a).includes('E2E');

let browser = null;
(async () => {
    const books0 = JSON.parse(await api('GET', '/books/list')).books;
    const book = books0.find(b => b.title.includes('非暴力沟通'));
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const bid = book.book_id;

    // ---- 0 清上轮残留 + 基线 ----
    for (const a of JSON.parse(await api('GET', '/assets?book_id=' + bid)).assets) {
        if (hasE2E(a)) await api('DELETE', '/assets/' + a.asset_id);
    }
    for (const s of (JSON.parse(await api('GET', '/sessions?scope=book&book_id=' + bid)).sessions || [])) {
        const full = JSON.parse(await api('GET', '/sessions/' + s.session_id));
        if (hasE2E(full)) await api('DELETE', '/sessions/' + s.session_id);
    }
    const baseline = new Set(JSON.parse(await api('GET', '/assets?book_id=' + bid)).assets.map(a => a.asset_id));

    // ---- 1 API 注入 3 条资产（文字 / 导图JSON / HTML） ----
    const mmJson = JSON.stringify({ t: 'E2E测试导图', c: [{ t: '第一章 观察' }, { t: '第二章 评论' }] });
    const htmlDoc = '<html><body><h1>E2E演示页</h1><p>精读笔记预览内容</p></body></html>';
    const aNote = JSON.parse(await api('POST', '/assets', { book_id: bid, type: 'note', content: 'E2E手工笔记：观察与评论的区别', title: 'E2E手工笔记' })).asset;
    const aMm = JSON.parse(await api('POST', '/assets', { book_id: bid, type: 'tool', tool_id: 'mindmap', tool_name: '思维导图', output_type: 'mindmap', content: mmJson, title: 'E2E测试导图' })).asset;
    const aHtml = JSON.parse(await api('POST', '/assets', { book_id: bid, type: 'tool', tool_id: 'close-read', tool_name: '精读笔记', output_type: 'html', content: htmlDoc, title: 'E2E演示页' })).asset;
    const apiAssets = async () => JSON.parse(await api('GET', '/assets?book_id=' + bid)).assets;
    say('注入 3 资产后 API 总数=3', (await apiAssets()).length === 3);

    // ---- 2 API 注入假会话：一条 kind=tool + 一条 kind=report（messages 是单消息端点，调两次） ----
    const sess = JSON.parse(await api('POST', '/sessions', { book_id: bid, scope: 'book' }));
    const sid = sess.session_id;
    await api('POST', `/sessions/${sid}/messages`, { role: 'assistant', kind: 'tool', content: 'E2E注入的工具产出正文，验证收藏结果按钮链路。', tool_id: 'summary', tool_name: '总结', output_type: 'text', scope: '第三章' });
    await api('POST', `/sessions/${sid}/messages`, { role: 'assistant', kind: 'report', content: 'E2E收束报告正文，验证归档报告按钮链路。' });

    // ---- 3 浏览器：书架预置旧 localStorage 收藏 2 条 → 进书 ----
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });


    for (let g = 0; ; g++) { try { await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded', timeout: 15000 }); break } catch (e) { if (g >= 2) throw e; await sleep(1500); } }
    await page.evaluate(() => localStorage.setItem('reading_favorites', JSON.stringify([
        { id: 'legacy1', type: 'qa', question: 'E2E旧问答', answer: 'E2E旧问答的答案内容', savedAt: '2026-11-01 10:00' },
        { id: 'legacy2', type: 'tool', toolId: 'summary', toolLabel: '总结', question: 'E2E旧工具产出', answer: 'E2E旧工具产出的内容', savedAt: '2026-11-02 09:00' },
    ])));
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });

    // ---- 4 自动恢复注入会话（最新 updated_at）→ 工具卡与报告卡渲染 ----
    const favBtn = await page.waitForSelector('button[title="收藏结果"]', { timeout: 15000 }).catch(() => null);
    say('进书自动恢复注入会话并渲染工具卡', !!favBtn);
    say('收束报告卡渲染（归档报告按钮）', await page.waitForSelector('button[title="归档报告"]', { timeout: 8000 }).then(() => true).catch(() => false));

    // ---- 5 localStorage 迁移：全部成功→key 清除→API 多 2 条 ----
    await page.waitForFunction(() => localStorage.getItem('reading_favorites') === null, null, { timeout: 10000 }).catch(() => {});
    say('迁移成功后旧收藏 key 已清除', await page.evaluate(() => localStorage.getItem('reading_favorites') === null));
    let list1 = await apiAssets();
    say('旧收藏 2 条已迁入后端（3+2=5）', list1.length === 5 && list1.some(a => (a.title || '').includes('E2E旧问答')) && list1.some(a => (a.title || '').includes('E2E旧工具产出')));

    // ---- 6 资产抽屉：打开 → 计数等数据就绪 ----
    await page.locator('button[title="资产"]').click();
    let drawerOpen = false;
    for (let i = 0; i < 20; i++) {
        drawerOpen = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '资产区'));
        if (drawerOpen) break;
        await sleep(200);
    }
    say('资产抽屉打开（带标题）', drawerOpen);
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-assets-count]');
        return el && el.textContent.trim() === '(5)';
    }, null, { timeout: 8000 }).catch(() => {});
    say('抽屉计数与 API 对账 (5)', await page.evaluate(() => (document.querySelector('[data-assets-count]') || {}).textContent?.trim() === '(5)'));
    say('导出链接指向后端', await page.evaluate(() => (document.querySelector('[data-assets-export]') || {}).href?.includes('/assets/export?book_id=') === true));

    // ---- 7 类型筛选 + 搜索 ----
    await page.locator('[data-assets-tab="tool"]').click();
    await sleep(300);
    say('筛选「AI 产出」= 3 条', await page.locator('[data-asset-item]').count() === 3);
    await page.locator('[data-assets-tab="all"]').click();
    await page.fill('input[placeholder="搜索资产"]', '手工笔记');
    await sleep(300);
    say('搜索命中 1 条', await page.locator('[data-asset-item]').count() === 1);
    await page.fill('input[placeholder="搜索资产"]', '');
    await sleep(300);

    // ---- 8 导图重放：展开注入的 JSON 资产 → 树节点渲染 ----
    await page.locator('[data-asset-item]').filter({ hasText: 'E2E测试导图' }).first().click();
    await sleep(500);
    await page.waitForSelector('[data-mindmap="json"][data-mm-ready="1"]', { timeout: 15000 }).catch(() => {});
    const mmFo = await page.evaluate(() => document.querySelectorAll('[data-mindmap="json"] .markmap-foreign').length);
    say('导图资产重放（≥2 节点，markmap 画布）', mmFo >= 2, 'nodes=' + mmFo);
    // ---- 9 HTML 预览：iframe srcdoc ----
    await page.locator('[data-asset-item]').filter({ hasText: 'E2E演示页' }).first().click();
    await sleep(500);
    const srcdoc = await page.locator('[data-asset-item]').filter({ hasText: 'E2E演示页' }).locator('iframe').getAttribute('srcdoc').catch(() => null);
    say('HTML 资产 iframe 预览', !!srcdoc && srcdoc.includes('E2E演示页'));

    // ---- 10 关闭抽屉（顶栏按钮被 z-50 面板盖住，用面板内关闭钮，与 SessionDrawer 同款锚点） ----
    await page.locator('button[title="关闭"]').click();
    await sleep(400);
    say('资产抽屉可关闭', await page.evaluate(() => !Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '资产区')));

    // ---- 11 工具卡「收藏结果」→ API+1 且按钮变「取消收藏」→ 再点取消 ----
    await page.locator('button[title="收藏结果"]').click();
    await sleep(800);
    let list2 = await apiAssets();
    say('工具产出收藏落库（5+1=6）', list2.length === 6 && list2.some(a => (a.content || '').includes('E2E注入的工具产出')));
    say('按钮态翻为「取消收藏」', await page.locator('button[title="取消收藏"]').count() === 1);
    await page.locator('button[title="取消收藏"]').click();
    await sleep(800);
    say('取消收藏后 API 回到 5', (await apiAssets()).length === 5);

    // ---- 12 报告卡「归档报告」→ 变「移出资产区」 ----
    await page.locator('button[title="归档报告"]').click();
    await sleep(800);
    let list3 = await apiAssets();
    say('报告归档落库（6 条·type=report）', list3.length === 6 && list3.some(a => a.type === 'report' && (a.content || '').includes('E2E收束报告')));
    say('按钮态翻为「移出资产区」', await page.locator('button[title="移出资产区"]').count() === 1);

    // ---- 13 抽屉内移除资产：计数 (6)→(5) ----
    await page.locator('button[title="资产"]').click();
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-assets-count]');
        return el && el.textContent.trim() === '(6)';
    }, null, { timeout: 8000 }).catch(() => {});
    const row = page.locator('[data-asset-item]').filter({ hasText: 'E2E手工笔记' }).first();
    await row.hover();
    await row.locator('button[title="移除资产"]').click();
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-assets-count]');
        return el && el.textContent.trim() === '(5)';
    }, null, { timeout: 8000 }).catch(() => {});
    say('移除资产后计数 (6)→(5)', await page.evaluate(() => (document.querySelector('[data-assets-count]') || {}).textContent?.trim() === '(5)'));
    await page.locator('button[title="关闭"]').click();  // 关抽屉
    await sleep(400);

    // ---- 14 导出 Markdown（节点侧直接拉后端） ----
    const md = await api('GET', '/assets/export?book_id=' + bid);
    say('导出 MD 含书名与注入内容', md.includes('# 《') && md.includes('E2E') && !md.includes('E2E手工笔记'));

    say('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    console.log('\n== 资产区 E2E:', PASS, 'passed,', FAIL, 'failed ==');

    // ---- 清理：本轮所有带 E2E 的资产 + 注入会话 ----
    for (const a of await apiAssets()) {
        if (hasE2E(a)) await api('DELETE', '/assets/' + a.asset_id);
    }
    await api('DELETE', '/sessions/' + sid);
    const left = (await apiAssets()).filter(hasE2E);
    console.log('  (清理后残留 E2E 资产:', left.length, ')');

    await browser.close();
    process.exit(FAIL > 0 ? 1 : 0);
})().catch(async e => {
    console.log('CRASH', e);
    if (browser) await browser.close().catch(() => {});
    process.exit(2);
});
