// v3.8.1 章节合并（核对弹窗"合并按钮"）浏览器级 E2E，零 LLM。
// 链路A(API契约)：注入重影草稿→commit merges→章数/拼接/标题取最长/锚点合并；三类 422
// 链路B(浏览器)：勾选合并工具条→合并徽标+行数→R11 行"⇧并上一章"→入库→API 对账
// 环境纪律：只清理本轮 TS 前缀的自己人——真实草稿（如斯托得核对稿）绝不 discard/delete
// 运行：node tests/e2e_merge.cjs（需服务在 127.0.0.1:8000 且为 v3.8.1 代码）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const DRAFT_DIR = path.join(__dirname, '..', 'backend', 'data', 'drafts');
const TS = Date.now();
const idOf = k => `e2emrg${TS}${k}`;

let PASS = 0, FAIL = 0;
const say = (name, cond, extra = '') => {
    if (cond) { PASS++; console.log('  ok  ', name, extra); }
    else { FAIL++; console.log('  FAIL', name, extra); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 300) => {
    const t0 = Date.now();
    for (;;) {
        try { if (await fn()) return true; } catch { /* 未就绪 */ }
        if (Date.now() - t0 > ms) return false;
        await sleep(step);
    }
};

function api(method, p, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE + p, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
        }, res => {
            let b = '';
            res.on('data', d => (b += d));
            res.on('end', () => {
                let parsed = null;
                try { parsed = b ? JSON.parse(b) : null; } catch { parsed = b; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function writeDraft(bookId, { title, chapters, qcItems, createdAt }) {
    const chs = chapters.map((c, i) => ({
        chapter_id: c.chapter_id, book_id: bookId, title: c.title, content: c.content,
        word_count: c.word_count ?? c.content.length, chapter_index: i,
        level: c.level ?? 1, cleaned_word_count: c.cleaned_word_count ?? c.content.length,
        start_position: c.start_position ?? null, end_position: c.end_position ?? null,
        created_at: new Date().toISOString(),
    }));
    const draft = {
        book_id: bookId, title, author: null, file_format: 'TXT',
        content_hash: `e2e-hash-${bookId}`, original_filename: `${title}.txt`,
        source: 'generic', resegmented: false,
        created_at: createdAt || new Date().toISOString(),
        chapters: chs, toc: [], total_words: chs.reduce((s, c) => s + c.word_count, 0),
        qc_report: { auto_commit: false, items: qcItems },
        dropped_empty: [],
    };
    fs.mkdirSync(DRAFT_DIR, { recursive: true });
    fs.writeFileSync(path.join(DRAFT_DIR, `${bookId}.json`), JSON.stringify(draft, null, 1), 'utf-8');
}

const para = (tag, n = 40) =>
    Array.from({ length: n }, (_, i) => `${tag}段落${i}，合并链路验证正文，内容足够长以通过滑窗切块与嵌入。`).join('\n\n');
const frag = tag => `${tag}章节页\n\n\n页码 037\n${'碎片残句'.repeat(30)}`; // ~130 字重影碎片

// 两对 R11 重影（章号同、剥号题面同、整串不等）+ 一章正常——斯托得草稿形态
function ghostChapters(pre) {
    return [
        { chapter_id: `${pre}1`, title: '第1章 面罩', content: frag('甲'), start_position: 100, end_position: 260 },
        { chapter_id: `${pre}2`, title: '第一章 面罩', content: para('甲'), start_position: 300, end_position: 9000 },
        { chapter_id: `${pre}3`, title: '第二章 正常', content: para('乙') },
        { chapter_id: `${pre}4`, title: '第3章 影子', content: frag('丙'), start_position: 20000, end_position: 20300 },
        { chapter_id: `${pre}5`, title: '第三章 影子', content: para('丙'), start_position: 20400, end_position: 31000 },
    ];
}
const ghostQc = pre => [
    { rule: 'R11', level: 'warning', msg: '标题重影（E2E 注入）', chapter_ids: [`${pre}1`, `${pre}2`] },
    { rule: 'R11', level: 'warning', msg: '标题重影（E2E 注入）', chapter_ids: [`${pre}4`, `${pre}5`] },
];

let browser = null;
(async () => {
    // ============ 链路 A：后端合并契约 ============
    const E = idOf('e'), F = idOf('f');
    writeDraft(E, { title: 'E2E合并书E', chapters: ghostChapters('e'), qcItems: ghostQc('e') });

    const cmtE = await api('POST', `/books/reviews/${E}/commit`, {
        delete_chapter_ids: [], renames: {}, force: false,
        merges: [['e1', 'e2'], ['e4', 'e5']],
    });
    say('A1 两对重影合并入库（5→3 章）', cmtE.status === 200 && cmtE.body.total_chapters === 3, `HTTP ${cmtE.status}`);
    const chsE = await waitFor(async () => {
        const r = await api('GET', `/books/${E}/chapters`);
        return r.status === 200 && Array.isArray(r.body) && r.body.length === 3;
    }) ? (await api('GET', `/books/${E}/chapters`)).body : null;
    say('A2 组长保序+标题取正文最长者', !!chsE && chsE[0].title === '第一章 面罩' && chsE[2].title === '第三章 影子',
        JSON.stringify((chsE || []).map(c => c.title)));
    say('A3 组长内容=碎片+正文拼接', !!chsE && chsE[0].content.startsWith('甲章节页') && chsE[0].content.includes('甲段落0'));

    writeDraft(F, { title: 'E2E合并书F校验', chapters: ghostChapters('f').slice(0, 3), qcItems: [{ rule: 'R11', level: 'warning', msg: '注入', chapter_ids: ['f1', 'f2'] }] });
    const dup = await api('POST', `/books/reviews/${F}/commit`, { merges: [['f1', 'f2'], ['f2', 'f3']], force: false });
    say('A4 跨组重复引用 → 422', dup.status === 422 && JSON.stringify(dup.body).includes('多个合并组'), `HTTP ${dup.status}`);
    const ghost = await api('POST', `/books/reviews/${F}/commit`, { merges: [['f1', 'nope']], force: false });
    say('A5 引用不存在章 → 422', ghost.status === 422 && JSON.stringify(ghost.body).includes('不存在'), `HTTP ${ghost.status}`);
    const conflict = await api('POST', `/books/reviews/${F}/commit`, { merges: [['f1', 'f2']], delete_chapter_ids: ['f2'], force: false });
    say('A6 既合并又删除 → 422', conflict.status === 422 && JSON.stringify(conflict.body).includes('既合并又删除'), `HTTP ${conflict.status}`);
    say('A7 422 后草稿未被吞（F 仍在核对列）', (await api('GET', '/books/reviews')).body.reviews.some(r => r.book_id === F));
    await api('POST', `/books/reviews/${F}/discard`); // 自己的 F，放心清

    // ============ 链路 B：浏览器合并交互 ============
    const G = idOf('g');
    writeDraft(G, { title: 'E2E合并书G', chapters: ghostChapters('g'), qcItems: ghostQc('g'), createdAt: new Date(Date.now() + 1000).toISOString() });

    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', d => d.accept());
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // B1 从书架顶栏徽标进核对（不依赖横幅计数——真实草稿可能同列）
    const chip = () => page.locator('[data-testid="draft-banner"] button, [data-testid="draft-review-entry"]');
    say('B1 待核对入口可见', await waitFor(() => chip().first().isVisible(), 10000));
    await page.locator('[data-testid="draft-banner"] button', { hasText: 'E2E合并书G' }).first().click();
    // 章名在受控 input 里、innerText 取不到——就绪信号用行内 data 契约（等末行 g5 渲染=全表到位）
    say('B2 弹层打开且 G 章树就绪', await waitFor(async () =>
        (await page.locator('[data-pr-mergepick="g5"]').count()) === 1 &&
        (await page.locator('[data-pr-title="g1"]').inputValue()) === '第1章 面罩', 15000));
    const mtxt = () => page.locator('[data-testid="parse-review-modal"]').innerText();

    // B3 勾选 g1(碎片) + g3(正常)——故意选非相邻两章验证通用合并
    await page.locator('[data-pr-mergepick="g1"]').check();
    await page.locator('[data-pr-mergepick="g3"]').check();
    say('B4 选中≥2 出现合并工具条', await page.locator('[data-testid="pr-merge-bar"]').isVisible());
    await page.locator('[data-pr-merge-do="1"]').click();
    say('B5 合并后 g1 挂已合并徽标、g3 行隐身', await waitFor(async () =>
        (await page.locator('[data-pr-merged="g1"]').count()) === 1 &&
        (await page.locator('[data-pr-mergepick="g3"]').count()) === 0, 8000));
    const g1Title = await page.locator('[data-pr-title="g1"]').inputValue();
    say('B6 预览标题取正文最长者（第二章 正常）', g1Title.includes('第二章 正常'), JSON.stringify(g1Title));
    const m = await mtxt();
    say('B7 底部入库计数 5→4', m.includes('确认入库（4 章）'), JSON.stringify(m.match(/确认入库（. 章）/)?.[0] || ''));

    // B8 R11 重影行走"⇧并上一章"快捷键：g5 与前一可见行 g4 并
    say('B8 重影行带 ⇧并上一章 按钮', await page.locator('[data-pr-mergeprev="g5"]').isVisible());
    await page.locator('[data-pr-mergeprev="g5"]').click();
    say('B9 快捷键合并生效（g4 徽标 ×2、g5 隐身）', await waitFor(async () =>
        (await page.locator('[data-pr-merged="g4"]').count()) === 1 &&
        (await page.locator('[data-pr-mergepick="g5"]').count()) === 0, 8000));

    // B10 组长被点删（v3.8.2 行尾垃圾桶钮为 toggle）→ 组自动散伙成员归位（防"既合并又删除"422）
    await page.locator('[data-pr-mergepick="g4"]').check();
    await page.locator('[data-pr-remove="g4"]').click();
    say('B10 点删组长自动散伙（g5 归位可再选）', await waitFor(async () =>
        (await page.locator('[data-pr-merged="g4"]').count()) === 0 &&
        (await page.locator('[data-pr-mergepick="g5"]').count()) === 1, 8000));
    await page.locator('[data-pr-remove="g4"]').click(); // 再点还原
    await page.locator('[data-pr-mergeprev="g5"]').click(); // 重新并上

    // B11 提交入库 → 队列推进/G 处理完
    await page.locator('[data-testid="pr-commit"]').click();
    say('B11 提交后 G 弹层关闭', await waitFor(async () => {
        const t = await mtxt().catch(() => '');
        return !t.includes('E2E合并书G');
    }, 15000));
    const chsG = await waitFor(async () => {
        const r = await api('GET', `/books/${G}/chapters`);
        return r.status === 200 && Array.isArray(r.body) && r.body.length === 3;
    }) ? (await api('GET', `/books/${G}/chapters`)).body : null;
    say('B12 浏览器合并真实落库（3 章、标题、拼接）', !!chsG &&
        chsG.map(c => c.chapter_id).join() === 'g1,g2,g4' &&
        chsG[0].title === '第二章 正常' &&
        chsG[2].title === '第三章 影子' &&
        chsG[2].content.includes('丙段落0'),
        JSON.stringify((chsG || []).map(c => [c.chapter_id, c.title])));
    say('B13 全程零 pageerror', errors.length === 0, errors.slice(0, 3).join(' | '));

    // ---- 清理：只删本轮自己人 ----
    await api('DELETE', `/books/${E}`);
    await api('DELETE', `/books/${G}`);
    await browser.close(); browser = null;

    console.log(`\n== e2e_merge: ${PASS} passed, ${FAIL} failed ==`);
    process.exit(FAIL > 0 ? 1 : 0);
})().catch(async e => {
    console.error('E2E_ERROR', e);
    if (browser) await browser.close().catch(() => {});
    process.exit(2);
});
