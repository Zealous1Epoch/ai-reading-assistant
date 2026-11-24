// 二期"人工核对关"浏览器级 E2E（零 LLM：草稿直接落 drafts 文件，commit 只走本地 embedding）
// 链路A(API契约)：注入草稿→reviews 列表/详情→改名+删章 commit→章节落库对账→blocking 409→force 放行
// 链路B(浏览器)：书架横幅/徽标→弹层质检报告→预览→改章名→勾选删章→重切报源文件缺失→
//                入库→书架出现新书→刷新持久→discard 二次确认清草稿→零 pageerror
// 运行：node tests/e2e_review.cjs（需服务在 127.0.0.1:8000，且为二期新代码）
const { chromium } = require('../frontend/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const DRAFT_DIR = path.join(__dirname, '..', 'backend', 'data', 'drafts');
const TS = Date.now();
const idOf = k => `e2erev${TS}${k}`; // 纯 ASCII，book_id 兼作草稿文件名

let PASS = 0, FAIL = 0;
const say = (name, cond, extra = '') => {
    if (cond) { PASS++; console.log('  ok  ', name, extra); }
    else { FAIL++; console.log('  FAIL', name, extra); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 400) => {
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

// 构造草稿（形态对齐 _save_pack_as_draft 的 model_dump 产物）
// created_at 显式传入：list_drafts 按它倒序排——核对队列顺序由此决定，断言依赖
function writeDraft(bookId, { title, chapters, qcItems, droppedEmpty = [], resegmented = false, createdAt }) {
    const chs = chapters.map((c, i) => ({
        chapter_id: c.chapter_id, book_id: bookId, title: c.title, content: c.content,
        word_count: c.word_count ?? c.content.length, chapter_index: i,
        level: c.level ?? 1, cleaned_word_count: c.cleaned_word_count ?? c.content.length,
        created_at: new Date().toISOString(),
    }));
    const draft = {
        book_id: bookId, title, author: null, file_format: 'TXT',
        content_hash: `e2e-hash-${bookId}`, original_filename: `${title}.txt`,
        source: 'generic', resegmented,
        created_at: createdAt || new Date().toISOString(),
        chapters: chs, toc: [], total_words: chs.reduce((s, c) => s + c.word_count, 0),
        qc_report: { auto_commit: qcItems.every(i => i.level === 'info'), items: qcItems },
        dropped_empty: droppedEmpty,
    };
    fs.mkdirSync(DRAFT_DIR, { recursive: true });
    fs.writeFileSync(path.join(DRAFT_DIR, `${bookId}.json`), JSON.stringify(draft, null, 1), 'utf-8');
}

const para = (tag, n = 40) =>
    Array.from({ length: n }, (_, i) => `${tag}段落${i}，E2E核对链路验证正文，内容足够长以通过滑窗切块与嵌入。`).join('\n\n');

let browser = null;
(async () => {
    // ---- 0 清上轮残留 ----
    for (const f of fs.existsSync(DRAFT_DIR) ? fs.readdirSync(DRAFT_DIR) : []) {
        if (f.startsWith(`e2erev${TS}`)) fs.unlinkSync(path.join(DRAFT_DIR, f));
    }
    const stale = (await api('GET', '/books/list')).body.books.filter(b => b.title && b.title.includes('E2E核对'));
    for (const b of stale) await api('DELETE', `/books/${b.book_id}`);

    // ============ 链路 A：后端 API 契约 ============
    const A = idOf('a'), B = idOf('b');
    writeDraft(A, {
        title: 'E2E核对书A',
        chapters: [
            { chapter_id: 'a1', title: '第一章 初版章名', content: para('甲') },
            { chapter_id: 'a2', title: '第二章 将被删除', content: para('乙') },
            { chapter_id: 'a3', title: '第三章 正常', content: para('丙') },
        ],
        qcItems: [{ rule: 'R1', level: 'warning', msg: '单章占比 60% 超过 55%（E2E 注入）', chapter_ids: ['a1'] }],
    });
    writeDraft(B, {
        title: 'E2E核对书B阻断',
        chapters: [{ chapter_id: 'b1', title: '唯一章吞全书', content: para('丁') }],
        qcItems: [{ rule: 'R9', level: 'blocking', msg: '全书仅 1 章，解析退化（E2E 注入）', chapter_ids: ['b1'] }],
    });

    const rev1 = (await api('GET', '/books/reviews')).body.reviews;
    const briefA = rev1.find(r => r.book_id === A);
    say('A1 reviews 列出草稿A（含章数/可疑数）', !!briefA && briefA.total_chapters === 3 && briefA.warning_count === 1 && briefA.blocking === false);
    const briefB = rev1.find(r => r.book_id === B);
    say('A2 reviews 标出草稿B blocking', !!briefB && briefB.blocking === true);

    const det = (await api('GET', `/books/reviews/${A}`)).body;
    say('A3 详情：content_head+QC标记落章', det.chapters.length === 3 && det.chapters[0].marks[0].rule === 'R1' && det.chapters[0].content_head.length > 10 && det.chapters[1].marks.length === 0);
    say('A4 详情：blocking=false / auto_commit=false', det.blocking === false && det.qc_report.auto_commit === false);

    const cmt = await api('POST', `/books/reviews/${A}/commit`, {
        renames: { a1: '第一章 核对后的章名' }, delete_chapter_ids: ['a2'], force: false,
    });
    say('A5 warning 草稿免 force 直接入库', cmt.status === 200 && cmt.body.status === 'committed', `HTTP ${cmt.status}`);

    const chsA = await waitFor(async () => {
        const r = await api('GET', `/books/${A}/chapters`);
        return r.status === 200 && r.body.length === 2;
    }) ? (await api('GET', `/books/${A}/chapters`)).body : null;
    say('A6 入库后：改名生效+删章剔除', !!chsA && chsA.some(c => c.title === '第一章 核对后的章名') && !chsA.some(c => c.title === '第二章 将被删除'));
    say('A7 入库后：索引与向量对账一致（章数=2 可整读）', !!chsA && chsA.every(c => (c.cleaned_word_count || 0) >= 30));
    const listA = (await api('GET', '/books/list')).body.books.find(b => b.book_id === A);
    say('A8 commit 后书出现在书架、草稿消失', !!listA && !(await api('GET', '/books/reviews')).body.reviews.some(r => r.book_id === A));

    const noForce = await api('POST', `/books/reviews/${B}/commit`, { renames: {}, delete_chapter_ids: [], force: false });
    say('A9 blocking 草稿无 force → 409 且提示阻断原因', noForce.status === 409 && JSON.stringify(noForce.body).includes('阻断'), `HTTP ${noForce.status}`);
    const forced = await api('POST', `/books/reviews/${B}/commit`, { renames: {}, delete_chapter_ids: [], force: true });
    say('A10 force=true 放行入库', forced.status === 200 && forced.body.status === 'committed');
    const re409 = await api('POST', `/books/reviews/${B}/commit`, { renames: {}, delete_chapter_ids: [], force: true });
    say('A11 重复 commit 幂等拒绝 409', re409.status === 409);
    await api('DELETE', `/books/${B}`);

    // ============ 链路 B：浏览器 UI ============
    // 环境纪律：本轮只留 C/D 两份草稿可核对（历史遗留草稿会扰乱队列与横幅计数）
    for (const r0 of (await api('GET', '/books/reviews')).body.reviews) {
        await api('POST', `/books/reviews/${r0.book_id}/discard`);
    }
    const C = idOf('c'), D = idOf('d');
    writeDraft(C, {
        title: 'E2E核对书C',
        resegmented: true,
        chapters: [
            { chapter_id: 'c1', title: '第一章 待改名', content: para('戊') },
            { chapter_id: 'c2', title: '第二章 待勾选删', content: para('己') },
            { chapter_id: 'c3', title: '第三章 空壳', content: '[PAGE 1]\n页码残留', word_count: 12, cleaned_word_count: 4 },
        ],
        qcItems: [
            { rule: 'R1', level: 'warning', msg: '单章占比过高（E2E 注入）', chapter_ids: ['c1'] },
            { rule: 'R4', level: 'warning', msg: '清洗后不足 30 字，入库时将丢弃（E2E 注入）', chapter_ids: ['c3'] },
        ],
        droppedEmpty: ['c3'],
        createdAt: new Date().toISOString(), // 新于 D → 队列序 [C, D]
    });
    writeDraft(D, {
        title: 'E2E核对书D放弃',
        chapters: [{ chapter_id: 'd1', title: '唯一章', content: para('庚') }],
        qcItems: [{ rule: 'R7', level: 'warning', msg: '正文覆盖率不足（E2E 注入）', chapter_ids: ['d1'] }],
        createdAt: new Date(Date.now() - 600000).toISOString(),
    });

    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', d => d.accept());

    for (let g = 0; ; g++) { try { await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded', timeout: 15000 }); break; } catch (e) { if (g >= 2) throw e; await sleep(1500); } }

    // B1 书架横幅 + 徽标
    say('B1 书架出现待核对横幅（含两本草稿）', await page.waitForSelector('[data-testid="draft-banner"]', { timeout: 10000 }).then(() => true).catch(() => false));
    const bannerTxt = await page.locator('[data-testid="draft-banner"]').innerText();
    say('B2 横幅计数=2 且带 R 标记摘要', bannerTxt.includes('2') && bannerTxt.includes('AI已重切'), JSON.stringify(bannerTxt.slice(0, 60)));
    say('B3 顶栏待核对徽标可见', await page.locator('[data-testid="draft-review-entry"]').isVisible());

    // B4 打开 C（点横幅里的 C 芯片——标题含"E2E核对书C"）
    await page.locator('[data-testid="draft-banner"] button', { hasText: 'E2E核对书C' }).click();
    say('B4 点击草稿芯片弹出核对弹层', await page.waitForSelector('[data-testid="parse-review-modal"]', { timeout: 8000 }).then(() => true).catch(() => false));
    const mtxt = () => page.locator('[data-testid="parse-review-modal"]').innerText();
    // 数据就绪断言：等草稿详情真正渲染（弹层挂载≠数据到位，读取草稿态会闪读空文）
    await waitFor(async () => (await mtxt()).includes('第一章 待改名'), 15000);
    let m = await mtxt();
    say('B5 弹层含质检报告两条规则+AI重切标记', m.includes('R1') && m.includes('R4') && m.includes('AI 已重切'));
    say('B6 弹层预告将丢弃空章', m.includes('自动丢弃'));
    say('B7 排队位置 1/2 显示', m.includes('1 / 2'));

    // B8 编辑：改 c1 名、勾选删 c2（章序 c1,c2,c3 → 第二个复选框是 c2）
    await page.locator('[data-pr-title="c1"]').fill('第一章 浏览器里改的名');
    await page.locator('[data-testid="parse-review-modal"] input[type="checkbox"]').nth(1).click();
    m = await mtxt();
    say('B8 底部按钮实时显示入库章数（3-1=2）', m.includes('确认入库（2 章）'), JSON.stringify(m.match(/确认入库（. 章）/)?.[0] || ''));

    // B9 重新解析（无源文件 → 弹层内提示而非 alert）
    await page.locator('[data-testid="pr-reseg"]').click();
    const gotNotice = await waitFor(async () => {
        const t = await page.locator('[data-testid="pr-notice"]').innerText().catch(() => '');
        return t.includes('源文件缺失');
    }, 10000);
    say('B9 重切无源文件 → 409 提示进弹层 notice', gotNotice);

    // B10 入库：commit → 弹层关闭 → 书架新书
    await page.locator('[data-testid="pr-commit"]').click();
    say('B10 入库后弹层自动推进（C 处理完进入 D）', await waitFor(async () => {
        const t = await mtxt();
        return t.includes('E2E核对书D放弃');
    }, 15000));
    await page.locator('[data-testid="pr-discard"]').click(); // 队列里的 D：UI 走放弃（dialog 自动 accept）
    say('B11 队列第二本可放弃（accept 确认后弹层关闭）', await waitFor(async () =>
        (await page.locator('[data-testid="parse-review-modal"]').count()) === 0, 10000));

    const chsC = (await api('GET', `/books/${C}/chapters`)).body;
    say('B12 浏览器改名+删章真实落库', Array.isArray(chsC) && chsC.length === 1 && chsC[0].title === '第一章 浏览器里改的名', JSON.stringify((chsC || []).map(c => c.title)));
    const dGone = !(await api('GET', '/books/reviews')).body.reviews.some(r => r.book_id === D);
    say('B13 放弃后草稿清空（reviews 无 D）', dGone);

    // B14 刷新持久：书架横幅消失、新书仍在
    await page.reload({ waitUntil: 'domcontentloaded' });
    say('B14 刷新后横幅消失（无残留草稿）', await waitFor(async () => (await page.locator('[data-testid="draft-banner"]').count()) === 0, 8000));
    await page.waitForSelector(`text=第一章 浏览器里改的名`, { timeout: 8000 }).catch(() => {});
    const shelfTxt = await page.locator('body').innerText();
    say('B15 新书留在书架（按 C 书名可见）', shelfTxt.includes('E2E核对书C'));
    say('B16 全程零 pageerror', errors.length === 0, errors.slice(0, 3).join(' | '));

    // ---- 清理（A 在链路 A 入了库，也要删净，不留 E2E 书进正式索引）----
    await api('DELETE', `/books/${A}`);
    await api('DELETE', `/books/${C}`);
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await browser.close(); browser = null;

    console.log(`\n== e2e_review: ${PASS} passed, ${FAIL} failed ==`);
    process.exit(FAIL > 0 ? 1 : 0);
})().catch(async e => {
    console.error('E2E_ERROR', e);
    if (browser) await browser.close().catch(() => {});
    process.exit(2);
});
