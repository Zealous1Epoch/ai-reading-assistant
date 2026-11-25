// v2.5 听书+播客 浏览器级 E2E —— 零 LLM 设计（edge-tts 走微软免费接口，DeepSeek 402 也能跑）
// 链路：进书选最短非孤章 → 听本章按钮（真实合成，上限 5 分钟）→ 播放条 audio 出 src → 浏览器端 fetch 验音频流 →
//       node 侧二次请求验缓存 → 工具抽屉播客表单（主题+时长档，不实际生成——台本要 LLM）→
//       API 注入 audio 资产验资产区播放分支 → 清理
// 运行：node tests/e2e_audio.cjs（需服务在 127.0.0.1:8000）
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
        const req = http.request(BASE + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined }, res => {
            let b = '';
            res.on('data', d => (b += d));
            res.on('end', () => resolve(b));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function probeStatus(path) {
    return new Promise((resolve, reject) => {
        http.get(BASE + path, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    });
}

let browser = null;
(async () => {
    // ---- 0 选章：按字数升序找非孤章（/books/chapters 探 200）；取第 2 个做合成章——
    //      第 1 个（第一章 801 字）大概率已有冒烟成品缓存，避开它才能走真实合成路径 ----
    const books = JSON.parse(await api('GET', '/books/list')).books;
    const book = books.find(b => b.title.includes('非暴力沟通'));
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }
    const bid = book.book_id;
    const sorted = (book.chapters || []).slice().sort((a, b) => (a.word_count || 1e9) - (b.word_count || 1e9));
    const okChs = [];
    for (const c of sorted.slice(0, 6)) {
        if (await probeStatus('/books/chapters/' + c.chapter_id) === 200) okChs.push(c);
        if (okChs.length >= 3) break;
    }
    if (okChs.length < 2) { console.log('NOT_ENOUGH_CHAPTERS'); process.exit(1); }
    const synthCh = okChs[1];
    console.log(`  (合成章=${synthCh.title.slice(0, 16)} ${synthCh.word_count}字)`);
    for (const a of JSON.parse(await api('GET', '/assets?book_id=' + bid)).assets) {
        if (JSON.stringify(a).includes('E2E音频')) await api('DELETE', '/assets/' + a.asset_id);
    }

    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    // ---- 1 进书 → 目录切到合成章 ----
    await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
    await page.locator('button').filter({ hasText: '非暴力沟通' }).first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/book/'), null, { timeout: 10000 });
    await page.locator('div[data-toc]').filter({ hasText: synthCh.title.slice(0, 10) }).first().click();
    const btn = await page.waitForSelector('button[data-listen-chapter]', { timeout: 15000 });
    say('章头「听本章」按钮就位', !!btn);

    // ---- 2 真实合成：点按钮 → 状态条 → 等 audio 播放条（整章合成上限 5 分钟） ----
    await page.locator('button[data-listen-chapter]').click();
    await sleep(800);
    const status = await page.locator('[data-listen-status]').innerText().catch(() => '');
    // 温跑兼容：该章 mp3 已在磁盘缓存时后端即时 done+cached，状态条不出现、播放条秒出
    const cachedFast = /排队|合成/.test(status) ? null
        : await page.waitForSelector('audio[data-audio-player]', { timeout: 3000 }).catch(() => null);
    say('合成状态条出现（或缓存命中直出播放条）', /排队|合成/.test(status) || !!cachedFast, status.slice(0, 20));
    const player = await page.waitForSelector('audio[data-audio-player]', { timeout: 300000 }).catch(() => null);
    say('合成完成，播放条出现（真实 edge-tts）', !!player);
    const src = player ? await player.getAttribute('src') : '';
    say('播放条 src 指向 /audio/file/*.mp3', /^\/audio\/file\/[0-9a-f]{40}\.mp3$/.test(src || ''), src);

    // 浏览器内 fetch 验证音频可取（与播放同源路径）
    const head = await page.evaluate(async (u) => {
        const r = await fetch(u);
        const ct = r.headers.get('content-type');
        const buf = await r.arrayBuffer();
        return { st: r.status, ct, len: buf.byteLength };
    }, src);
    say('浏览器端拉取 mp3=200 audio/mpeg 且非空', head.st === 200 && /audio\/mpeg/.test(head.ct || '') && head.len > 4000, `len=${head.len}`);

    // ---- 3 node 侧二次请求：命中磁盘缓存（无任务、直接 done+cached） ----
    const again = JSON.parse(await api('POST', '/audio/chapter', { book_id: bid, chapter_id: synthCh.chapter_id }));
    say('二次请求命中缓存', again.status === 'done' && again.cached === true && again.url === src);

    // ---- 4 工具抽屉：播客表单（不实际生成——台本需 LLM，待充值随播客回归复跑） ----
    // v3.1：工具入口并入 AI 面板 ➕ 级联
    await page.locator('[data-testid="plus-menu"]').click();
    await page.locator('button').filter({ hasText: /^工具$/ }).first().click();
    await page.waitForSelector('[data-tool-menu]', { timeout: 5000 });
    await page.locator('[data-tool-menu] button').filter({ hasText: '读书播客' }).first().click();
    const topicIn = await page.waitForSelector('[data-podcast-topic]', { timeout: 5000 }).catch(() => null);
    say('播客主题输入展开', !!topicIn);
    const chips = await page.locator('[data-podcast-minutes] button').allInnerTexts();
    say('时长档 10/20/30', chips.join(',').includes('10') && chips.includes('30 分钟'));
    await page.locator('[data-podcast-minutes] button').filter({ hasText: '30' }).click();
    say('30 分钟档可选为激活', await page.evaluate(() => Array.from(document.querySelectorAll('[data-podcast-minutes] button')).some(b => /30/.test(b.textContent) && b.className.includes('bg-zinc-800'))));
    say('主题空时生成按钮禁用', await page.locator('button').filter({ hasText: /^生成$/ }).first().isDisabled());
    await page.fill('[data-podcast-topic]', 'E2E测试主题');
    say('输入主题后解禁', await page.locator('button').filter({ hasText: /^生成$/ }).first().isEnabled());
    // v2.8-B：重新生成一期开关（默认关，点击后 pressed+高亮，可再点回）
    const regenBtn = page.locator('[data-podcast-regen]');
    say('regen 开关存在且默认关', await regenBtn.count() === 1 && await regenBtn.getAttribute('aria-pressed') === 'false');
    await regenBtn.click();
    say('点击后 aria-pressed=true 且样式高亮', await regenBtn.getAttribute('aria-pressed') === 'true'
        && (await regenBtn.getAttribute('class')).includes('bg-amber-50'));
    await regenBtn.click();
    say('可再点回关', await regenBtn.getAttribute('aria-pressed') === 'false');

    // 关弹层（v3.1 起工具并入 AI 面板 ➕ 级联，背板是 AiPanel 的 fixed inset-0 z-30）
    await page.locator('div.fixed.inset-0.z-30').last().click({ position: { x: 10, y: 10 } });
    await sleep(400);
    say('播客表单可经背板关闭', await page.locator('[data-podcast-topic]').count() === 0);

    // ---- 5 资产区 audio 分支：API 注入一条播客资产 → 刷新让 App 重新 loadAssets → 抽屉展开出播放器 ----
    const inj = JSON.parse(await api('POST', '/assets', {
        book_id: bid, type: 'tool', tool_id: 'podcast', tool_name: '读书播客',
        output_type: 'audio', content: src, title: 'E2E音频资产',
    })).asset;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('button[title="资产"]', { timeout: 15000 });
    await sleep(800);   // 进书 loadAssets 拉新
    await page.locator('button[title="资产"]').click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('h3')).some(h => h.textContent.trim() === '资产区'), null, { timeout: 8000 });
    await page.waitForSelector('[data-asset-item]', { timeout: 5000 });
    const row = page.locator('[data-asset-item]').filter({ hasText: 'E2E音频资产' }).first();
    await row.click();
    await sleep(400);
    const aud = await page.locator(`audio[data-asset-audio="${inj.asset_id}"]`).getAttribute('src').catch(() => null);
    say('资产区 audio 分支播放器（src=资产内容）', aud === src, aud);
    await row.hover();
    await row.locator('button[title="移除资产"]').click();
    await sleep(600);
    say('移除后 API 资产回基线', (await api('GET', '/assets?book_id=' + bid)).includes(inj.asset_id) === false);
    await page.locator('button[title="关闭"]').click();

    say('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    console.log('\n== 听书播客 E2E:', PASS, 'passed,', FAIL, 'failed ==');
    await browser.close();
    process.exit(FAIL > 0 ? 1 : 0);
})().catch(async e => {
    console.log('CRASH', e);
    if (browser) await browser.close().catch(() => {});
    process.exit(2);
});
