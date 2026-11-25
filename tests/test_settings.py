"""设置面板（v3.5）：settings_store 两层合并/校验/掩码/版本号 + 路由 + LLM 热重建"""

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.services import settings_store
from app.routers import settings as settings_router


@pytest.fixture
def store_env(tmp_path, monkeypatch):
    """落盘指向 tmp + 模块级缓存/版本号复位（测试间零串扰）"""
    monkeypatch.setattr(settings_store, "_path", lambda: str(tmp_path / "runtime_settings.json"))
    monkeypatch.setattr(settings_store, "_cache", {})
    monkeypatch.setattr(settings_store, "_loaded", False)
    monkeypatch.setattr(settings_store, "_version", 0)
    return tmp_path


def _env_cfg(monkeypatch, **kw):
    """把 get_settings 单例上的 env 默认改成测试值（monkeypatch 自动还原）"""
    from app.config import get_settings
    s = get_settings()
    for k, v in kw.items():
        monkeypatch.setattr(s, k, v)


class TestStore:
    def test_env_fallback(self, store_env, monkeypatch):
        _env_cfg(monkeypatch, deepseek_api_key="sk-env", deepseek_base_url="https://env/v1", deepseek_model="env-m")
        cfg = settings_store.llm_config()
        assert cfg == {"api_key": "sk-env", "base_url": "https://env/v1", "model": "env-m"}

    def test_runtime_override_and_version(self, store_env, monkeypatch):
        _env_cfg(monkeypatch, deepseek_api_key="sk-env", deepseek_base_url="https://env/v1", deepseek_model="env-m")
        v0 = settings_store.version()
        settings_store.update_llm(base_url="https://rt/v1/", model="rt-m")
        assert settings_store.version() == v0 + 1
        cfg = settings_store.llm_config()
        assert cfg["base_url"] == "https://rt/v1"       # 尾斜杠被剥
        assert cfg["model"] == "rt-m"
        assert cfg["api_key"] == "sk-env"               # 未覆盖项回落 env

    def test_empty_values_mean_keep(self, store_env, monkeypatch):
        _env_cfg(monkeypatch, deepseek_api_key="sk-env", deepseek_base_url="https://env/v1", deepseek_model="env-m")
        settings_store.update_llm(base_url="  ", model="", api_key="")
        cfg = settings_store.llm_config()
        assert cfg["base_url"] == "https://env/v1" and cfg["model"] == "env-m"

    def test_persist_roundtrip(self, store_env, monkeypatch):
        settings_store.update_tts(voice_a="zh-CN-YunjianNeural", rate="+15%")
        # 模拟进程重启：清缓存强制从盘重读
        monkeypatch.setattr(settings_store, "_cache", {})
        monkeypatch.setattr(settings_store, "_loaded", False)
        t = settings_store.tts_config()
        assert t["voice_a"] == "zh-CN-YunjianNeural" and t["rate"] == "+15%"
        assert t["voice_b"] == settings_store.DEFAULT_TTS["voice_b"]  # 未设项走默认

    def test_tts_validation(self, store_env):
        with pytest.raises(ValueError):
            settings_store.update_tts(rate="fast")
        with pytest.raises(ValueError):
            settings_store.update_tts(voice_a="not a voice!")
        # 校验失败不落盘、版本不动
        assert settings_store.version() == 0
        assert not (store_env / "runtime_settings.json").exists()

    def test_mask_key(self):
        assert settings_store.mask_key("sk-abcdef123456") == "••••3456"
        assert settings_store.mask_key("short") == "••••"
        assert settings_store.mask_key("") == ""


class TestRouter:
    def test_get_shape_no_plaintext_key(self, store_env, monkeypatch):
        _env_cfg(monkeypatch, deepseek_api_key="sk-secret-9999", deepseek_base_url="https://env/v1", deepseek_model="m")
        d = asyncio.run(settings_router.get_settings_api())
        assert d["llm"]["api_key_masked"] == "••••9999"
        assert d["llm"]["api_key_set"] is True
        assert "sk-secret" not in str(d)                 # 明文 key 绝不进响应
        assert d["tts"]["voice_a"]

    def test_put_llm_rejects_bad_scheme(self, store_env):
        with pytest.raises(HTTPException) as e:
            asyncio.run(settings_router.put_llm(settings_router.LlmUpdate(base_url="ftp://x/v1")))
        assert e.value.status_code == 422

    def test_put_llm_saves_and_bumps(self, store_env):
        d = asyncio.run(settings_router.put_llm(
            settings_router.LlmUpdate(base_url="https://a/v1", model="mm", api_key="sk-new-1234")))
        assert d["llm"]["api_key_masked"] == "••••1234"
        assert d["version"] == 1

    def test_put_tts_422(self, store_env):
        with pytest.raises(HTTPException) as e:
            asyncio.run(settings_router.put_tts(settings_router.TtsUpdate(rate="+9")))
        assert e.value.status_code == 422


class TestLlmHotReload:
    """热生效核心断言：update 后（版本 bump）服务再取 .llm 必须是新配置对象"""

    def test_ai_service_rebuilds_on_version_bump(self, store_env, monkeypatch):
        from app.services.ai_service import AIService
        _env_cfg(monkeypatch, deepseek_api_key="sk-aaa", deepseek_base_url="https://old/v1", deepseek_model="old-m")
        svc = AIService()
        llm1 = svc.llm
        assert str(llm1.openai_api_base) == "https://old/v1"
        assert svc.llm is llm1                            # 版本未变：复用不重建

        settings_store.update_llm(base_url="https://new/v1", model="new-m", api_key="sk-bbb")
        llm2 = svc.llm
        assert llm2 is not llm1
        assert str(llm2.openai_api_base) == "https://new/v1"
        assert llm2.model_name == "new-m"

    def test_analysis_streaming_rebuilds(self, store_env, monkeypatch):
        from app.services.analysis_service import AnalysisService
        _env_cfg(monkeypatch, deepseek_api_key="sk-aaa", deepseek_base_url="https://old/v1", deepseek_model="old-m")
        svc = AnalysisService()
        s1 = svc.streaming_llm
        settings_store.update_tts(voice_a="zh-CN-YunjianNeural")   # 任意写入都 bump 版本（含 TTS，代价是一次重建，无正确性风险）
        assert svc.streaming_llm is not s1

    def test_injected_stub_survives_version_bump(self, store_env, monkeypatch):
        """外部注入槽（测试打桩 _llm=...）必须永远优先，版本 bump 也不得被换成真 ChatOpenAI
        ——v3.5 首版热重建直接比 _llm 版本，test_draft_flow 桩被无声替换跑了真模型"""
        from app.services.ai_service import AIService
        from app.services.analysis_service import AnalysisService
        from app.services.book_processor import BookProcessor
        _env_cfg(monkeypatch, deepseek_api_key="sk-aaa", deepseek_base_url="https://old/v1", deepseek_model="old-m")
        for svc in (AIService(), AnalysisService()):
            fake = object()
            svc._llm = fake
            settings_store.update_llm(base_url="https://x/v1", model="m", api_key="sk-k")
            assert svc.llm is fake
        fake2 = object()
        svc_a = AnalysisService()
        svc_a._streaming_llm = fake2
        settings_store.update_llm(base_url="https://y/v1", model="m2", api_key="sk-k2")
        assert svc_a.streaming_llm is fake2
        # BookProcessor 的注入存活由 test_draft_flow_api 的 BrokenLLM 全链路实锤
