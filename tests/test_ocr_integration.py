"""扫描书云端 OCR 链路（v3.8）：新质检规则 R11-R14 / OCR 触发路由 / 设置项 / 书名回退 / 百度客户端重试"""

import sys
from pathlib import Path

import pytest

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))
_ROOT = Path(__file__).parent.parent

from app.models.book_models import BookAnalysisResult, Chapter
from app.services import settings_store
from app.services.quality_check import run_quality_check


def mk_chapter(title="第X章 测试", content="正文" * 100, idx=0, cid=None, **kw):
    return Chapter(
        chapter_id=cid or f"ch-{idx}",
        book_id="book-1",
        title=title,
        content=content,
        word_count=len(content),
        chapter_index=idx,
        **kw,
    )


# ── R11 标题重影 ────────────────────────────────────────────────
class TestR11GhostTitle:
    def test_same_title_adjacent(self):
        """斯托得实锤：「第二章 像基督」565 字 + 同名 3795 字"""
        chapters = [
            mk_chapter("第一章 不隨波逐流", "字" * 4000, 0),
            mk_chapter("第二章 像基督", "字" * 565, 1),
            mk_chapter("第二章 像基督", "字" * 3795, 2),
            mk_chapter("第三章 長大成熟", "字" * 4000, 3),
        ]
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R11"]
        assert len(hits) == 1
        assert hits[0].level == "warning"
        assert not report.auto_commit

    def test_mixed_digit_form_same_rest(self):
        """「第3章 長大成熟」vs「第三章 長大成熟」：章号数字写法不同也须命中"""
        chapters = [
            mk_chapter("第3章 長大成熟", "字" * 590, 0),
            mk_chapter("第三章 長大成熟", "字" * 4407, 1),
        ]
        report = run_quality_check(chapters)
        assert any(it.rule == "R11" for it in report.items)

    def test_same_number_different_rest_not_hit(self):
        """同章号但题面不同（测试夹具常见的重排形态）不误伤"""
        chapters = [
            mk_chapter("第一章 让爱融入生活", "字" * 3000, 0),
            mk_chapter("第一章 标题0", "字" * 3000, 1),
        ]
        report = run_quality_check(chapters)
        assert not any(it.rule == "R11" for it in report.items)


# ── R12 目录条目章成片 ─────────────────────────────────────────
class TestR12TocEntries:
    def test_cluster_triggers(self):
        chapters = [
            mk_chapter("第 6 章 前言：門徒或基督徒？", "字" * 126, 0),
            mk_chapter("第 7 章 不隨波逐流", "字" * 57, 1),
            mk_chapter("第8章 長大成熟", "字" * 142, 2),
            mk_chapter("第一章 不隨波逐流", "字" * 4051, 3),
        ]
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R12"]
        assert hits and hits[0].level == "warning"
        assert len(hits[0].chapter_ids) == 3
        assert not report.auto_commit

    def test_scatter_not_trigger(self):
        """零星 2 个短章 < 成片线，属正常小节"""
        chapters = [
            mk_chapter("第1章 短", "字" * 100, 0),
            mk_chapter("第2章 也短", "字" * 120, 1),
            mk_chapter("第3章 长", "字" * 5000, 2),
            mk_chapter("第4章 也长", "字" * 5000, 3),
        ]
        report = run_quality_check(chapters)
        assert not any(it.rule == "R12" for it in report.items)

    def test_long_numbered_not_trigger(self):
        chapters = [mk_chapter(f"第{i+1}章 章", "字" * 4000, i) for i in range(5)]
        report = run_quality_check(chapters)
        assert not any(it.rule == "R12" for it in report.items)


# ── R13 前置内容超长 ───────────────────────────────────────────
class TestR13FrontLead:
    def test_triggers(self):
        chapters = [
            mk_chapter("前置内容", "字" * 8586, 0),
            mk_chapter("第一章 正题", "字" * 4051, 1),
        ]
        report = run_quality_check(chapters)
        hits = [it for it in report.items if it.rule == "R13"]
        assert hits and hits[0].level == "warning"
        assert not report.auto_commit

    def test_normal_lead_not_trigger(self):
        chapters = [
            mk_chapter("前置内容", "字" * 2000, 0),
            mk_chapter("第一章 正题", "字" * 4051, 1),
        ]
        report = run_quality_check(chapters)
        assert not any(it.rule == "R13" for it in report.items)


# ── R14 OCR 来源强制人工核对 ───────────────────────────────────
class TestR14OcrSource:
    def _chapters(self):
        # 6 章 × 5000 字：避开 R2（>8 万字的书不足 8 章）干扰，专测 R14
        return [mk_chapter(f"第{i+1}章 章", "字" * 5000, i) for i in range(6)]

    def test_ocr_engine_forces_review(self):
        report = run_quality_check(self._chapters(), ocr_engine="baidu")
        assert any(it.rule == "R14" and it.level == "warning" for it in report.items)
        assert not report.auto_commit

    def test_no_engine_clean(self):
        report = run_quality_check(self._chapters())
        assert not any(it.rule == "R14" for it in report.items)
        assert report.auto_commit


# ── 重切触发集 ─────────────────────────────────────────────────
def test_reseg_triggers():
    from app.services.book_processor import RESEG_TRIGGERS
    assert "R11" in RESEG_TRIGGERS and "R12" in RESEG_TRIGGERS
    # 封面文案与 OCR 来源重切治不了，不该触发
    assert "R13" not in RESEG_TRIGGERS and "R14" not in RESEG_TRIGGERS


# ── PDF 扫描画像 + OCR 路由 ────────────────────────────────────
class TestPdfOcrRouting:
    """自包含：fitz 现造扫描样/电子书样 PDF（旧版钉死 uploads 馆藏文件，删书即漂）"""

    @pytest.fixture()
    def processor(self):
        from app.services.book_processor import book_processor
        return book_processor

    @pytest.fixture(scope="class")
    def scan_pdf(self, tmp_path_factory):
        """扫描形态：3 页整页大图 + ~116 ASCII 字/页垃圾文字层（>20 字/页 → 走垃圾层线而非纯扫描线）"""
        import fitz
        p = tmp_path_factory.mktemp("ocrpdf") / "scan_junk.pdf"
        doc = fitz.open()
        for _ in range(3):
            page = doc.new_page(width=595, height=842)
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 240, 340))
            pix.set_rect(pix.irect, (180, 180, 180))
            page.insert_image(page.rect, pixmap=pix)
            page.insert_text((72, 100), "OCR GARBAGE LAYER 0123456789 " * 4, fontname="helv")
        doc.save(str(p))
        doc.close()
        return str(p)

    @pytest.fixture(scope="class")
    def ebook_pdf(self, tmp_path_factory):
        """电子书形态：纯文字层无图片（helv 不支持中文，样本用 ASCII）"""
        import fitz
        p = tmp_path_factory.mktemp("ocrpdf") / "ebook.pdf"
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for i in range(30):
            page.insert_text((72, 80 + i * 20), f"body line {i} " + "normal text " * 8, fontname="helv")
        doc.save(str(p))
        doc.close()
        return str(p)

    def test_scan_profile_separates(self, processor, scan_pdf, ebook_pdf):
        """校准口径：整页图扫描 ~100%，纯文字电子书 0%（阈值 60% 缓冲巨大）"""
        import fitz
        junk = processor._pdf_scan_profile(fitz.open(scan_pdf))
        ebook = processor._pdf_scan_profile(fitz.open(ebook_pdf))
        assert junk["img_ratio"] >= 0.9
        assert ebook["img_ratio"] <= 0.1

    def test_junk_layer_with_key_goes_cloud(self, processor, monkeypatch, scan_pdf):
        """垃圾文字层 + 已配密钥 → 云端 OCR 整本重认并打 from_ocr 标"""
        from app.services import baidu_ocr
        monkeypatch.setattr(baidu_ocr, "is_configured", lambda: True)
        monkeypatch.setattr(processor, "_ocr_pdf_baidu",
                            lambda doc, book_id="": "[PAGE 1]\n" + ("云端识别文字" * 20000))
        text, meta = processor.extract_text_from_pdf(scan_pdf)
        assert meta.get("from_ocr") is True
        assert meta.get("ocr_engine") == "baidu"
        assert text.startswith("[PAGE 1]\n云端")

    def test_junk_layer_without_key_keeps_layer(self, processor, monkeypatch, scan_pdf):
        """垃圾文字层但没配密钥：沿用原层，不打 OCR 标（不炸不装）"""
        from app.services import baidu_ocr
        monkeypatch.setattr(baidu_ocr, "is_configured", lambda: False)
        _t, meta = processor.extract_text_from_pdf(scan_pdf)
        assert "from_ocr" not in meta

    def test_clean_ebook_untouched(self, processor, monkeypatch, ebook_pdf):
        """正常电子书 PDF：即使配了密钥也不该触发 OCR"""
        from app.services import baidu_ocr
        monkeypatch.setattr(baidu_ocr, "is_configured", lambda: True)
        called = {"n": 0}
        monkeypatch.setattr(processor, "_ocr_pdf_baidu",
                            lambda doc, book_id="": called.__setitem__("n", called["n"] + 1) or "")
        _t, meta = processor.extract_text_from_pdf(ebook_pdf)
        assert called["n"] == 0 and "from_ocr" not in meta


# ── 设置：ocr 配置存取 + 掩码 + token 作废 ────────────────────
class TestOcrSettings:
    @pytest.fixture
    def store_env(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings_store, "_path", lambda: str(tmp_path / "runtime_settings.json"))
        monkeypatch.setattr(settings_store, "_cache", {})
        monkeypatch.setattr(settings_store, "_loaded", False)
        monkeypatch.setattr(settings_store, "_version", 0)
        return tmp_path

    def test_env_fallback(self, store_env, monkeypatch):
        from app.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "baidu_ocr_api_key", "env-ak")
        monkeypatch.setattr(s, "baidu_ocr_secret_key", "env-sk")
        cfg = settings_store.ocr_config()
        assert cfg == {"api_key": "env-ak", "secret_key": "env-sk"}

    def test_runtime_override_and_token_invalidate(self, store_env, monkeypatch):
        from app.services import baidu_ocr
        calls = []
        monkeypatch.setattr(baidu_ocr, "invalidate_token", lambda: calls.append(1))
        settings_store.update_ocr(api_key="rt-ak", secret_key="rt-sk")
        assert settings_store.ocr_config()["api_key"] == "rt-ak"
        assert calls == [1]  # 保存即作废旧 token

    def test_empty_means_keep(self, store_env):
        settings_store.update_ocr(api_key="ak-keep", secret_key="sk-keep")
        settings_store.update_ocr(api_key="  ", secret_key="")
        cfg = settings_store.ocr_config()
        assert cfg["api_key"] == "ak-keep" and cfg["secret_key"] == "sk-keep"

    def test_router_public_masked_and_put(self, store_env, monkeypatch):
        from app.routers import settings as sr
        resp = sr._public()
        assert resp["ocr"]["configured"] is False
        import asyncio
        updated = asyncio.run(sr.put_ocr(sr.OcrUpdate(api_key="abcdef12345", secret_key="xyzw98765")))
        assert updated["ocr"]["configured"] is True
        assert updated["ocr"]["api_key_masked"].startswith("••••")
        assert "abcdef" not in str(updated)  # 掩码口径：明文绝不出接口

    def test_router_test_endpoint(self, store_env, monkeypatch):
        from app.routers import settings as sr
        from app.services import baidu_ocr
        import asyncio

        def fake_test(api_key="", secret_key=""):
            if api_key == "bad":
                raise baidu_ocr.BaiduOcrError("Invalid client")
        monkeypatch.setattr(baidu_ocr, "test_connection", fake_test)
        ok = asyncio.run(sr.test_ocr(sr.OcrTest(api_key="good", secret_key="s")))
        assert ok["ok"] is True
        bad = asyncio.run(sr.test_ocr(sr.OcrTest(api_key="bad", secret_key="s")))
        assert bad["ok"] is False and "Invalid client" in bad["detail"]


# ── 书名回退全格式 ─────────────────────────────────────────────
class TestTitleFallback:
    def _result(self, title, fmt):
        return BookAnalysisResult(book_id="uuid-1", title=title, author="x",
                                  total_chapters=1, total_words=10, chapters=[], toc=[],
                                  file_format=fmt)

    def test_pdf_uuid_title_backfilled(self):
        from app.routers.book_processor import _apply_display_title
        r = self._result("uuid-1", "PDF")
        _apply_display_title(r, "世界在等待的门徒 （斯托得）.pdf")
        assert r.title == "世界在等待的门徒 （斯托得）"

    def test_real_metadata_title_kept(self):
        from app.routers.book_processor import _apply_display_title
        r = self._result("魔鬼家书：地狱来鸿", "PDF")
        _apply_display_title(r, "魔鬼家书：地狱来鸿 (z-library).pdf")
        assert r.title == "魔鬼家书：地狱来鸿"

    def test_empty_title_backfilled(self):
        from app.routers.book_processor import _apply_display_title
        r = self._result("", "EPUB")
        _apply_display_title(r, "a book.epub")
        assert r.title == "a book"


# ── 百度客户端：token 缓存 + 限流重试 ──────────────────────────
class TestBaiduClient:
    def setup_method(self):
        from app.services import baidu_ocr
        baidu_ocr.invalidate_token()

    def test_token_cached_across_calls(self, monkeypatch):
        from app.services import baidu_ocr
        n = {"calls": 0}

        class R:
            def json(self):
                return {"access_token": "tok-1", "expires_in": 1000}

            def __init__(self): pass

        def fake_post(url, params=None, data=None, timeout=None):
            if "oauth" in url:
                n["calls"] += 1
            return R()
        monkeypatch.setattr(baidu_ocr.requests, "post", fake_post)
        monkeypatch.setattr(settings_store, "ocr_config",
                            lambda: {"api_key": "ak", "secret_key": "sk"})
        t1 = baidu_ocr.get_token()
        t2 = baidu_ocr.get_token()
        assert t1 == t2 == "tok-1" and n["calls"] == 1

    def test_rate_limit_retries_then_succeeds(self, monkeypatch):
        from app.services import baidu_ocr
        attempts = {"n": 0}
        monkeypatch.setattr(baidu_ocr, "get_token", lambda force_refresh=False: "tok")
        monkeypatch.setattr(baidu_ocr.time, "sleep", lambda s: None)

        class Resp:
            def __init__(self, payload): self._p = payload
            def json(self): return self._p

        def fake_post(url, params=None, data=None, timeout=None):
            attempts["n"] += 1
            if attempts["n"] < 3:
                return Resp({"error_code": 14, "error_msg": "Hit service rate limit"})
            return Resp({"words_result": [{"words": "第一章"}, {"words": "正文"}], "words_result_num": 2})
        monkeypatch.setattr(baidu_ocr.requests, "post", fake_post)
        out = baidu_ocr.ocr_image(b"png")
        assert out == "第一章\n正文" and attempts["n"] == 3

    def test_nonretryable_fails_fast(self, monkeypatch):
        from app.services import baidu_ocr
        attempts = {"n": 0}
        monkeypatch.setattr(baidu_ocr, "get_token", lambda force_refresh=False: "tok")

        class Resp:
            def json(self):
                return {"error_code": 216602, "error_msg": "image size is limited"}
        def fake_post(url, params=None, data=None, timeout=None):
            attempts["n"] += 1
            return Resp()
        monkeypatch.setattr(baidu_ocr.requests, "post", fake_post)
        with pytest.raises(baidu_ocr.BaiduOcrError):
            baidu_ocr.ocr_image(b"big")
        assert attempts["n"] == 1  # 计费接口：非限流错误绝不重试

    def test_not_configured_raises(self, monkeypatch):
        from app.services import baidu_ocr
        monkeypatch.setattr(settings_store, "ocr_config", lambda: {"api_key": "", "secret_key": ""})
        assert baidu_ocr.is_configured() is False
        with pytest.raises(baidu_ocr.BaiduOcrNotConfigured):
            baidu_ocr.get_token()
