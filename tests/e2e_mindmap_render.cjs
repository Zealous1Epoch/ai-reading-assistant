// v2.9 思维导图 markmap 画布渲染冒烟（零 LLM）：复用存量旧会话里的导图 JSON，验证画布渲染/层级切换/跳原文/全屏/SVG 导出
// 运行：node tests/e2e_mindmap_render.cjs（需服务已在 127.0.0.1:8000 运行）
const { chromium } = require('../frontend/node_modules/playwright');
const BASE = 'http://127.0.0.1:8000';
let PASS = 0, FAIL = 0;
const say = (name, cond, extra) => {
    if (cond) { PASS++; console.log('  ok  ', name, extra || ''); }
    else { FAIL++; console.log('  FAIL', name, extra || ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const visibleNodes = page => page.evaluate(() =>
    document.querySelectorAll('[data-mindmap="json"] .markmap-foreign').length);

let browser = null;
(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    // 进非暴力沟通（存量导图会话所属书）→ 会话抽屉切到含导图的旧会话
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    await page.locator('button[title="会话"]').click();
    await page.getByText('思维导图 · 工具产出').first().click();
    await sleep(800);

    let ready = false;
    try { await page.waitForSelector('[data-mindmap="json"][data-mm-ready="1"]', { timeout: 15000 }); ready = true; } catch { }
    say('存量导图 markmap 画布 ready', ready);
    if (!ready) { await page.screenshot({ path: '/tmp/v29_smoke_fail.png' }); throw new Error('画布未渲染'); }
    await sleep(800);

    const attr = await page.evaluate(() => {
        const el = document.querySelector('[data-mindmap="json"]');
        return {
            chapters: Number(el.getAttribute('data-mm-chapters')),
            jumps: document.querySelectorAll('[data-mindmap="json"] [data-mm-jump]').length,
            circles: document.querySelectorAll('[data-mindmap="json"] svg circle').length,
        };
    });
    say('章数=跳转链接数', attr.chapters === attr.jumps, JSON.stringify(attr));
    // v2.9.1 起详分支入口并入折叠圆圈，无独立按钮；存量树章下必有主题层时圆圈=1根+N章，宽容断言下限
    say('折叠圆圈存在（根+章节点）', attr.circles >= 1 && attr.circles <= attr.chapters + 1, String(attr.circles));
    const n1 = await visibleNodes(page);
    say('默认展开到章：节点=1根+N章', n1 === attr.chapters + 1, `渲染 ${n1}`);
    await page.screenshot({ path: '/tmp/v29_smoke_canvas.png' });

    // 层级切换：存量冒烟数据可能无主题层（两层骨架），有主题层才断言增多，否则断言保持不崩
    await page.locator('[data-mm-toolbar] button').filter({ hasText: '展开到主题' }).click();
    await sleep(1200);
    const n2 = await visibleNodes(page);
    if (n2 > n1) say('展开到主题节点增多', true, `${n1} → ${n2}`);
    else say('展开到主题：数据无主题层时保持原节点且不报错', n2 === n1 && !errors.length, `${n1} → ${n2}（该存量树为两层骨架）`);

    // 跳原文（事件委托）：foreignObject 内 <a> 可能被面板吸顶头遮挡，用 JS 原生 click 验证委托链路本身
    const cid = await page.locator('[data-mm-jump]').nth(1).getAttribute('data-mm-jump');
    const label = (await page.locator(`[data-mm-jump="${cid}"]`).first().innerText()).trim();
    await page.evaluate(c => document.querySelector(`[data-mm-jump="${c}"]`).click(), cid);
    await sleep(1500);
    say('点章名跳原文（阅读区出现该章标题）',
        await page.evaluate(t => document.body.innerText.includes(t), label), label.slice(0, 20));

    // SVG 导出
    try {
        const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 8000 }),
            page.locator('[data-mm-toolbar] button').filter({ hasText: 'SVG' }).click(),
        ]);
        say('SVG 导出触发下载', /\.svg$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    } catch { say('SVG 导出触发下载', false); }

    // PNG 导出（canvas 栅格化 foreignObject，失败允许但必须记录）
    try {
        const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 8000 }),
            page.locator('[data-mm-toolbar] button').filter({ hasText: 'PNG' }).click(),
        ]);
        say('PNG 导出触发下载', /\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    } catch { say('PNG 导出触发下载（允许降级 SVG，上方 SVG 已验）', false); }

    // 全屏开关
    await page.locator('[data-mm-toolbar] button').filter({ hasText: '放大' }).click();
    await sleep(600);
    const fs = await page.evaluate(() => !!document.querySelector('.fixed.inset-0.z-50 svg'));
    say('放大=容器换类不换实例', fs);
    await page.screenshot({ path: '/tmp/v29_smoke_fullscreen.png' });
    await page.locator('button[title="关闭"]').last().click();
    await sleep(400);
    say('全屏可关闭', await page.evaluate(() => !document.querySelector('.fixed.inset-0.z-50 svg')));

    say('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
    console.log('\nPASS ' + PASS + '  FAIL ' + FAIL);
    if (FAIL) process.exitCode = 1;
})().catch(async e => {
    console.log('CRASH', e);
    process.exitCode = 2;
    try { if (browser) await browser.close(); } catch { }
});
