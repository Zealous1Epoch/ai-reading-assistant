// v3.1 布局调整浏览器级 E2E（零 LLM：纯 UI 断言，不触发任何模型调用）
// 链路：顶栏按钮换位（目录/会话贴近书名，右侧仅剩 AI/卡片/资产，工具按钮移除）→
//       ➕ 级联（专家模式+工具，向左展开不出屏，播客表单内联）→
//       三区拖宽（toc/AI 手柄、持久化、双击复位、折叠后手柄消失）
// 运行：node tests/e2e_layout.cjs（需服务在 127.0.0.1:8000）
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

async function boxOf(page, selector) {
    const el = await page.$(selector);
    return el ? el.boundingBox() : null;
}
async function paneWidth(page, pane) {
    return page.evaluate(p => {
        const el = document.querySelector(`[data-pane="${p}"]`);
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
    }, pane);
}
async function drag(page, selector, dx) {
    const box = await boxOf(page, selector);
    if (!box) return false;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx / 2, cy, { steps: 4 });
    await page.mouse.move(cx + dx, cy, { steps: 4 });
    await page.mouse.up();
    await sleep(150);
    return true;
}

let browser = null;
(async () => {
    const books0 = JSON.parse(await api('GET', '/books/list')).books;
    const book = books0[0];
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const url = `${BASE}/#/book/${book.book_id}`;

    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    for (let g = 0; ; g++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); break } catch (e) { if (g >= 2) throw e; await sleep(1500); } }
    // 清掉三区开合/宽度存档后重载，回到确定性基线（toc 展开 216 / AI 展开 400）
    await page.evaluate(() => localStorage.removeItem('reader_ui'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pane="toc"]', { timeout: 15000 });
    await page.waitForSelector('[data-pane="ai"]', { timeout: 10000 });

    // ---- 1 顶栏按钮换位 ----
    const h1 = await boxOf(page, 'h1');
    const bToc = await boxOf(page, 'button[title="目录"]');
    const bSess = await boxOf(page, 'button[title="会话"]');
    const bAi = await boxOf(page, 'button[title="AI"]');
    const bCards = await boxOf(page, 'button[title="卡片"]');
    const bAssets = await boxOf(page, 'button[title="资产"]');
    const bTool = await boxOf(page, 'button[title="工具"]');
    say('顶栏不再有无「工具」开关', bTool === null);
    say('目录/会话在书名右侧', !!h1 && !!bToc && !!bSess && bToc.x > h1.x && bSess.x > h1.x);
    say('目录在会话左侧、两者都在 AI 左侧', !!bToc && !!bSess && !!bAi && bToc.x < bSess.x && bSess.x < bAi.x);
    say('AI/卡片/资产仍在右缘', !!bAi && !!bCards && !!bAssets && bAi.x < bCards.x && bCards.x < bAssets.x && bAssets.x > 1200);

    // ---- 2 ➕ 级联：方向翻转 + 工具并入 ----
    await page.locator('[data-testid="plus-menu"]').click();
    await sleep(200);
    const groupTool = page.locator('[data-testid="plus-menu"] ~ * button, button').filter({ hasText: /^工具$/ }).first();
    const hasGroupTool = await groupTool.count() > 0;
    say('➕ 一级菜单出现「工具」项', hasGroupTool);
    const groupExperts = page.locator('button').filter({ hasText: /^专家模式$/ }).first();
    say('➕ 一级菜单仍有「专家模式」', await groupExperts.count() > 0);
    const vw = await page.evaluate(() => window.innerWidth);

    await groupExperts.click();
    await sleep(200);
    const expertPanel = await boxOf(page, '[data-testid="plus-menu"] + div >> nth=-1').catch(() => null);
    // 直接量所有一级/二级面板包围盒：全部不出视口
    const panelsIn = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.absolute.bottom-full')).every(b => {
            const r = b.getBoundingClientRect();
            return r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0;
        }));
    say('专家子面板整体在视口内', panelsIn, `vw=${vw}`);

    await groupTool.click();
    await sleep(250);
    say('工具子面板出现（tool-scope 可见）', await page.$('[data-tool-menu] [data-testid="tool-scope"]') !== null);
    const panelsIn2 = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.absolute.bottom-full')).every(b => {
            const r = b.getBoundingClientRect();
            return r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0;
        }));
    say('工具子面板整体在视口内（旧版在此越出屏幕右缘）', panelsIn2);
    say('范围切换默认=当前章', await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('[data-testid="tool-scope"] button'));
        return btns.length === 2 && btns[0].className.includes('bg-zinc-800');
    }));

    // 播客内联表单（只展开不生成，零 LLM）
    await page.locator('[data-tool-menu] button').filter({ hasText: '读书播客' }).first().click();
    await sleep(200);
    say('播客主题输入内联展开', await page.$('[data-podcast-topic]') !== null);
    // 点遮罩关菜单
    await page.mouse.click(700, 40);
    await sleep(200);
    say('点空白收起 ➕ 菜单', await page.$('[data-tool-menu]') === null);

    // ---- 3 三区拖宽 ----
    const w0 = await paneWidth(page, 'toc');
    say('目录栏基线宽 216', w0 === 216, `w0=${w0}`);
    say('AI 栏基线宽 400', (await paneWidth(page, 'ai')) === 400);
    say('toc 手柄存在', await page.$('[data-resize="toc"]') !== null);

    const ok1 = await drag(page, '[data-resize="toc"]', 64);
    const w1 = await paneWidth(page, 'toc');
    say('拖宽目录栏 +64', ok1 && w1 === 280, `w1=${w1}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pane="toc"]', { timeout: 15000 });
    const w2 = await paneWidth(page, 'toc');
    say('刷新后目录栏宽保持 280', w2 === 280, `w2=${w2}`);

    await page.dblclick('[data-resize="toc"]');
    await sleep(150);
    say('双击手柄复位 216', (await paneWidth(page, 'toc')) === 216);

    // AI 侧手柄：向左拖 = 变宽
    const ok2 = await drag(page, '[data-resize="ai"]', -80);
    const wa = await paneWidth(page, 'ai');
    say('向左拖宽 AI 栏 +80', ok2 && wa === 480, `wa=${wa}`);
    // 越界钳制：狂拖到上限 760
    await drag(page, '[data-resize="ai"]', -1500);
    say('AI 栏钳制在上限 760', (await paneWidth(page, 'ai')) === 760);
    await page.dblclick('[data-resize="ai"]');
    await sleep(150);
    say('AI 栏双击复位 400', (await paneWidth(page, 'ai')) === 400);

    // 折叠目录后手柄消失、恢复展开后手柄回来
    await page.locator('button[title="目录"]').click();
    await sleep(200);
    say('折叠目录后手柄消失', await page.$('[data-resize="toc"]') === null);
    await page.locator('button[title="目录"]').click();
    await sleep(200);
    say('重新展开后手柄恢复', await page.$('[data-resize="toc"]') !== null);

    // ---- 4 无 JS 报错 ----
    say('全程无 pageerror/console 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

    console.log(`\n== e2e_layout: ${PASS} pass / ${FAIL} fail ==`);
    await browser.close();
    process.exit(FAIL ? 1 : 0);
})().catch(async e => { console.error('RUNNER_ERROR', e); if (browser) await browser.close(); process.exit(2); });
