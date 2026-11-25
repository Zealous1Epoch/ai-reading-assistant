"""百度 OCR 客户端（通用文字识别·高精度版）

用途：扫描版 PDF / 垃圾文字层 PDF 的逐页识别（书数字段的云端兜底）。
接口：https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic_highprecision
      一张页图一次调用；access_token 有效期 30 天，进程内缓存、临期自动刷新。

密钥：设置面板"扫描书 OCR"区 → runtime_settings.json（本机 gitignored），
      兼容 .env 的 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY。

重试口径：限流类（4/14/18）指数退避重试；token 失效（110/111）强制刷新一次
再重试；其余错误码直接抛 BaiduOcrError——计费接口上盲重试是烧钱不是兜底。
"""
import base64
import threading
import time

import requests

from app.services import settings_store

TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
API_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic_highprecision"

# 高精度版默认 2 QPS：并发压到 2，配合退避基本不触发限流
MAX_WORKERS = 2
# 百度文档口径：图片长边 ≤4096px；渲染侧按此钳制（见 book_processor）
MAX_IMAGE_EDGE = 4096
REQUEST_TIMEOUT = 60  # 秒，单页高精度含网络一般 2-5s

_RETRYABLE_CODES = {4, 14, 18}      # 并发超限 / 速率超限
_TOKEN_BAD_CODES = {110, 111}       # token 无效 / 过期


class BaiduOcrError(RuntimeError):
    """调用失败（含认证、参数、图片质量、重试用尽）"""


class BaiduOcrNotConfigured(BaiduOcrError):
    """未配置密钥"""


# ── access_token 缓存（进程内） ────────────────────────────────
_tok_lock = threading.Lock()
_tok = {"token": "", "exp": 0.0}  # exp: epoch 秒


def is_configured() -> bool:
    cfg = settings_store.ocr_config()
    return bool(cfg["api_key"] and cfg["secret_key"])


def get_token(force_refresh: bool = False) -> str:
    """拿 access_token；提前 5 分钟视为过期。并发下同一把锁，最多打一次网络。"""
    with _tok_lock:
        now = time.time()
        if not force_refresh and _tok["token"] and _tok["exp"] - 300 > now:
            return _tok["token"]
        cfg = settings_store.ocr_config()
        if not (cfg["api_key"] and cfg["secret_key"]):
            raise BaiduOcrNotConfigured("未配置百度 OCR 密钥")
        try:
            r = requests.post(
                TOKEN_URL,
                params={
                    "grant_type": "client_credentials",
                    "client_id": cfg["api_key"],
                    "client_secret": cfg["secret_key"],
                },
                timeout=REQUEST_TIMEOUT,
            )
            data = r.json()
        except (requests.RequestException, ValueError) as e:
            raise BaiduOcrError(f"获取百度 OCR access_token 失败：{e}") from e
        if "access_token" not in data:
            raise BaiduOcrError(f"获取百度 OCR access_token 失败：{data.get('error_description') or data}")
        _tok["token"] = data["access_token"]
        _tok["exp"] = now + int(data.get("expires_in", 2592000))
        return _tok["token"]


def invalidate_token() -> None:
    """配置变更后清缓存（settings 更新时可调，版本号方案外的保险）"""
    with _tok_lock:
        _tok["token"] = ""
        _tok["exp"] = 0.0


def ocr_image(png_bytes: bytes) -> str:
    """识别一页 PNG。返回按行拼接的纯文本；失败抛 BaiduOcrError。

    计费接口：非限流错误一律不重试（错一次也是钱），由调用方决定是否继续。
    """
    b64 = base64.b64encode(png_bytes).decode()
    last_err = "未知错误"
    token_refreshed = False
    for attempt in range(4):
        token = get_token(force_refresh=token_refreshed)
        token_refreshed = False
        try:
            r = requests.post(
                API_URL,
                params={"access_token": token},
                data={"image": b64, "language_type": "CHN_ENG"},
                timeout=REQUEST_TIMEOUT,
            )
            data = r.json()
        except (requests.RequestException, ValueError) as e:
            last_err = str(e)
            time.sleep(1.5 * (2 ** attempt))  # 网络抖动可重试
            continue
        if "words_result" in data:
            return "\n".join(w.get("words", "") for w in data["words_result"])
        code = data.get("error_code")
        if code in _TOKEN_BAD_CODES and not token_refreshed:
            token_refreshed = True  # 刷一次 token 再走下一轮
            continue
        if code in _RETRYABLE_CODES:
            last_err = f"限流（error_code={code}）"
            time.sleep(1.5 * (2 ** attempt))
            continue
        raise BaiduOcrError(
            f"百度 OCR 识别失败 error_code={code}: {data.get('error_msg', '未知')}")
    raise BaiduOcrError(f"百度 OCR 重试 4 次仍失败：{last_err}")


def test_connection(api_key: str = "", secret_key: str = "") -> None:
    """连通性测试：用「表单值 > 已存配置」拉一次 token，成功即返回。"""
    cfg = settings_store.ocr_config()
    key = (api_key or "").strip() or cfg["api_key"]
    sec = (secret_key or "").strip() or cfg["secret_key"]
    if not (key and sec):
        raise BaiduOcrNotConfigured("尚未配置 API Key / Secret Key")
    r = requests.post(
        TOKEN_URL,
        params={"grant_type": "client_credentials", "client_id": key, "client_secret": sec},
        timeout=REQUEST_TIMEOUT,
    )
    data = r.json()
    if "access_token" not in data:
        raise BaiduOcrError(data.get("error_description") or f"认证失败：{data}")
