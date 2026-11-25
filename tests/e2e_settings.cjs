// v3.5 设置面板浏览器级 E2E（零 LLM：不点"测试连接"，不发消息；TTS 保存后立即还原）
// 链路：书架齿轮开面板 → 深色主题挂 html.dark → 进书验证纸张变量+字号即时生效 →
//       LLM 区掩码显示（无明文 key）→ TTS 改音色保存回读 → Esc 关闭 → 状态还原
// 运行：node tests/e2e_settings.cjs（需服务在 127.0.0.1:8000）
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
        const req = http.request(BASE + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined },
            res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve(b)); });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function goto(page, url) {
    for (let g = 0; ; g++) {
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); return; }
        catch (e) { if (g >= 2) throw e; await sleep(1500); }
    }
}

let browser = null;
(async () => {
    const settings0 = JSON.parse(await api('GET', '/api/settings'));
    const books0 = (JSON.parse(await api('GET', '/books/list'))).books;
    const book = books0[0];
    if (!book) { console.log('BOOK_NOT_FOUND'); process.exit(1); }

    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    // —— 书架：齿轮入口 + 面板开关 + 主题切换 ——
    await goto(page, BASE + '/#/');
    await page.waitForSelector('[data-open-settings]');
    await page.evaluate(() => localStorage.removeItem('app_appearance'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-open-settings]');
    say('默认浅色：html 无 dark 类', !(await page.evaluate(() => document.documentElement.classList.contains('dark'))));

    await page.click('[data-open-settings]');
    await page.waitForSelector('[data-testid="settings-modal"]');
    say('齿轮打开设置面板', true);
    // 数据就绪再断言：等 data-ready（弹层挂载/select 默认首项都不算就绪——实锤竞态教训）
    await page.waitForSelector('[data-ready="1"]', { timeout: 8000 });

    await page.click('[data-ap-theme="dark"]');
    say('点深色 → html 挂 dark 类', await page.evaluate(() => document.documentElement.classList.contains('dark')));

    // LLM 区：掩码展示、无明文 key、key 输入框为空（留空=不改）
    const masked = await page.$eval('[data-testid="settings-modal"]', el => el.textContent);
    say('LLM Key 显示掩码', masked.includes('••••') || masked.includes('未配置'));
    say('响应文案不含明文 key 头', !masked.includes('sk-'));
    say('Key 输入框留空', (await page.$eval('[data-set-key]', el => el.value)) === '');
    say('base_url 已回填', (await page.$eval('[data-set-baseurl]', el => el.value)).startsWith('http'));

    // Esc 关闭
    await page.keyboard.press('Escape');
    await sleep(200);
    say('Esc 关闭面板', !(await page.$('[data-testid="settings-modal"]')));

    // —— 进书：纸张 + 字号即时生效 ——
    await goto(page, `${BASE}/#/book/${book.book_id}`);
    await page.waitForSelector('.reader-surface', { timeout: 10000 });
    const bgWhite = await page.$eval('.reader-surface', el => getComputedStyle(el).backgroundColor);
    say('白纸基线背景', bgWhite === 'rgb(255, 255, 255)', bgWhite);

    await page.click('[data-open-settings]');
    await page.waitForSelector('[data-testid="settings-modal"]');
    await page.click('[data-ap-paper="dark"]');
    await sleep(150);
    const bgDark = await page.$eval('.reader-surface', el => getComputedStyle(el).backgroundColor);
    say('切深色纸 → 容器背景即变', bgDark === 'rgb(31, 31, 35)', bgDark);

    // 字号：range 用原生 setter 触发 React onChange
    await page.$eval('[data-ap-fontsize]', el => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '20');
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(150);
    const fs = await page.$eval('.reader-body p:not(.reader-heading)', el => getComputedStyle(el).fontSize).catch(() => 'NO_P');
    say('字号滑到 20 → 正文 font-size 20px', fs === '20px', fs);
    say('字号数值回显', (await page.$eval('[data-ap-fontsize-val]', el => el.textContent)).includes('20'));

    // 持久化：重载后外观仍在
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.reader-surface');
    const persisted = await page.evaluate(() => {
        return {
            dark: document.documentElement.classList.contains('dark'),
            paper: document.querySelector('.reader-surface')?.getAttribute('data-paper'),
        };
    });
    say('重载后深色主题仍在', persisted.dark === true);
    say('重载后纸张仍为深色纸', persisted.paper === 'dark');

    // —— TTS：改音色保存 → API 回读 → 面板显示 → 还原 ——
    await page.click('[data-open-settings]');
    await page.waitForFunction(() => { const el = document.querySelector('[data-set-voice-a]'); return el && el.value.length > 0; }, { timeout: 8000 });
    await page.waitForSelector('[data-ready="1"]', { timeout: 8000 });
    await page.selectOption('[data-set-voice-a]', 'zh-CN-YunjianNeural');
    await page.click('[data-set-tts-save]');
    await page.waitForSelector('[data-set-tts-result]', { timeout: 5000 });
    const ttsOk = await page.$eval('[data-set-tts-result]', el => el.textContent);
    say('TTS 保存成功提示', ttsOk.includes('已保存'), ttsOk);
    const after = JSON.parse(await api('GET', '/api/settings'));
    say('API 回读音色已变', after.tts.voice_a === 'zh-CN-YunjianNeural', 'got=' + after.tts.voice_a + ' ver=' + after.version);
    await api('PUT', '/api/settings/tts', { voice_a: settings0.tts.voice_a, voice_b: settings0.tts.voice_b, rate: settings0.tts.rate });
    const back = JSON.parse(await api('GET', '/api/settings'));
    say('音色还原干净', back.tts.voice_a === settings0.tts.voice_a && back.tts.rate === settings0.tts.rate);

    // —— 导出按钮存在即算过（不点：资产有无随库状态漂移，404 路径后端已单测）——
    say('数据导出按钮就位', !!(await page.$('[data-set-export]')));

    // 状态还原：清外观，别把深色留给其它 E2E
    await page.evaluate(() => localStorage.removeItem('app_appearance'));

    await page.screenshot({ path: '/tmp/e2e_settings_dark.png', fullPage: false });
        say('零页面 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    console.log(`\nE2E settings: PASS=${PASS} FAIL=${FAIL}`);
    await browser.close();
    process.exit(FAIL > 0 ? 1 : 0);
})().catch(async e => { console.error('E2E_CRASH:', e); if (browser) await browser.close(); process.exit(2); });
