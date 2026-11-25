"""运行时设置接口（v3.5 设置面板）

- GET  /api/settings            当前生效配置（api_key 只回掩码，绝不回明文）
- PUT  /api/settings/llm        改端点/模型/key → 落盘 + 版本 bump → 各服务下次取用即重建
- POST /api/settings/llm/test   连通性测试：可带未保存的表单值试跑，省得保存后才发现填错
- PUT  /api/settings/tts        改播客/听书音色与语速（校验在 settings_store，非法 422）
"""
import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import settings_store

router = APIRouter(prefix="/api/settings", tags=["设置"])


class LlmUpdate(BaseModel):
    base_url: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


class LlmTest(LlmUpdate):
    pass


class TtsUpdate(BaseModel):
    voice_a: Optional[str] = None
    voice_b: Optional[str] = None
    rate: Optional[str] = None


class ExportUpdate(BaseModel):
    obsidian_dir: Optional[str] = None


class OcrUpdate(BaseModel):
    api_key: Optional[str] = None
    secret_key: Optional[str] = None


class OcrTest(OcrUpdate):
    pass


def _public() -> dict:
    cfg = settings_store.llm_config()
    tts = settings_store.tts_config()
    ocr = settings_store.ocr_config()
    return {
        "llm": {
            "base_url": cfg["base_url"],
            "model": cfg["model"],
            "api_key_masked": settings_store.mask_key(cfg["api_key"]),
            "api_key_set": bool(cfg["api_key"]),
        },
        "tts": tts,
        "export": settings_store.export_config(),
        "ocr": {
            "api_key_masked": settings_store.mask_key(ocr["api_key"]),
            "secret_key_masked": settings_store.mask_key(ocr["secret_key"]),
            "configured": bool(ocr["api_key"] and ocr["secret_key"]),
        },
        "version": settings_store.version(),
    }


@router.get("")
async def get_settings_api():
    return _public()


@router.put("/llm")
async def put_llm(req: LlmUpdate):
    if req.base_url is not None and req.base_url.strip():
        bu = req.base_url.strip()
        if not bu.startswith(("http://", "https://")):
            raise HTTPException(status_code=422, detail="base_url 须以 http(s):// 开头")
    try:
        settings_store.update_llm(base_url=req.base_url, model=req.model, api_key=req.api_key)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _public()


@router.post("/llm/test")
async def test_llm(req: LlmTest):
    """用「表单值 > 已存配置」合并出的参数发一次最小请求。失败不抛 5xx，回 ok=false 带原因。"""
    from langchain_openai import ChatOpenAI

    cfg = settings_store.llm_config()
    base_url = (req.base_url or "").strip() or cfg["base_url"]
    model = (req.model or "").strip() or cfg["model"]
    api_key = (req.api_key or "").strip() or cfg["api_key"]
    if not api_key:
        return {"ok": False, "detail": "尚未配置 API Key"}
    if not base_url.startswith(("http://", "https://")):
        return {"ok": False, "detail": "base_url 须以 http(s):// 开头"}
    try:
        llm = ChatOpenAI(
            model=model,
            openai_api_key=api_key,
            openai_api_base=base_url,
            max_tokens=16,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        await asyncio.wait_for(llm.ainvoke("回复“ok”两个字母即可。"), timeout=30)
        return {"ok": True, "detail": f"连通正常（{model}）"}
    except asyncio.TimeoutError:
        return {"ok": False, "detail": "30 秒超时：端点不可达或排队严重"}
    except Exception as e:  # noqa: BLE001 — 网络/鉴权/模型名错等一律转成人话回给前端
        msg = str(e) or e.__class__.__name__
        return {"ok": False, "detail": msg[:240]}


@router.put("/tts")
async def put_tts(req: TtsUpdate):
    try:
        settings_store.update_tts(voice_a=req.voice_a, voice_b=req.voice_b, rate=req.rate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _public()


@router.put("/export")
async def put_export(req: ExportUpdate):
    """v3.7 批注导出目录（Obsidian「读点书吧」）；空串恢复默认。设置面板暂不展示此项，留作 API 配置。"""
    try:
        settings_store.update_export(obsidian_dir=req.obsidian_dir)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _public()


@router.put("/ocr")
async def put_ocr(req: OcrUpdate):
    """百度 OCR（通用高精度）密钥：扫描书云端兜底。留空 = 不修改。"""
    settings_store.update_ocr(api_key=req.api_key, secret_key=req.secret_key)
    return _public()


@router.post("/ocr/test")
async def test_ocr(req: OcrTest):
    """用「表单值 > 已存配置」拉一次 access_token 验证密钥。不烧识别额度。"""
    from app.services import baidu_ocr
    try:
        await asyncio.wait_for(
            asyncio.to_thread(baidu_ocr.test_connection, req.api_key or "", req.secret_key or ""),
            timeout=30,
        )
        return {"ok": True, "detail": "鉴权正常（token 已获取）"}
    except baidu_ocr.BaiduOcrNotConfigured as e:
        return {"ok": False, "detail": str(e)}
    except asyncio.TimeoutError:
        return {"ok": False, "detail": "30 秒超时：aip.baidubce.com 不可达"}
    except Exception as e:  # noqa: BLE001 — 鉴权/网络错误统一转人话
        return {"ok": False, "detail": str(e)[:240]}
