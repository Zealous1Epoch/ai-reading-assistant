// v3.8 扫描书 OCR 设置区 E2E：区块可见 / 保存后掩码回显 / 明文绝不出屏 / 无 JS 错误
// 用后即焚口径：测完由 run 脚本把 runtime_settings.json 的 ocr 段清掉（不落假密钥）
const { chromium } = require('../frontend/node_modules/playwright');

const BASE = process.env.BASE_URL || 'http://localhost:5173';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok   ${name} ${extra}`); }
    else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(String(e)));

    await page.goto(BASE, { waitUntil: 'networkidle' });

    // 打开设置（齿轮，同 e2e_settings 口径）
    await page.click('[data-open-settings]');
    await page.waitForSelector('[data-testid="settings-modal"] [data-ready="1"]', { timeout: 10000 });
    const modal = page.locator('[data-testid="settings-modal"]');

    ok('OCR 配置区可见', await modal.getByText('扫描书 OCR').first().isVisible());
    ok('未配置态文案', await modal.getByText('未配置').first().isVisible());

    // 填假密钥 → 保存 → 断言掩码回显且明文不在 DOM
    await modal.locator('[data-set-ocr-key]').fill('testAK1234567890');
    await modal.locator('[data-set-ocr-secret]').fill('testSK9876543210');
    await modal.locator('[data-set-ocr-save]').click();
    await page.waitForSelector('[data-set-ocr-result]', { timeout: 10000 });
    ok('保存成功提示', (await modal.locator('[data-set-ocr-result]').textContent()).includes('已保存'));

    await page.waitForTimeout(300);
    const body = await modal.innerHTML();
    ok('回显为已配置', body.includes('已配置'));
    ok('掩码不含明文', !body.includes('testAK') && !body.includes('testSK'));
    ok('输入框已清空', (await modal.locator('[data-set-ocr-key]').inputValue()) === ''
        && (await modal.locator('[data-set-ocr-secret]').inputValue()) === '');

    // 后端接口同样只回掩码
    const resp = await page.request.get(`${BASE}/api/settings`);
    const txt = await resp.text();
    ok('API 不含明文密钥', !txt.includes('testAK') && !txt.includes('testSK'));
    const j = JSON.parse(txt);
    ok('API ocr.configured=true', j.ocr && j.ocr.configured === true);
    ok('掩码尾 4 位', j.ocr.api_key_masked.endsWith('7890'), j.ocr.api_key_masked);

    ok('零页面 JS 错误', jsErrors.length === 0, jsErrors.join('|'));

    await browser.close();
    console.log(`\nE2E ocr settings: PASS=${pass} FAIL=${fail}`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E_CRASH:', e); process.exit(2); });
