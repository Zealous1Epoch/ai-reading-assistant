"""运行时设置存储（v3.5 设置面板）

LLM / TTS 配置允许在 UI 里修改并**立即生效**（不必重启）：
- 持久化在 data/runtime_settings.json（原子写，与 chat_store 同款套路）；
- 未设置的字段回落到 .env（get_settings），即"运行时覆盖 > 环境变量"两层合并；
- 每次写入 bump 进程内 `_version`；各 LLM 服务在延迟初始化属性里比对版本号，
  版本变了就重建 ChatOpenAI——这就是"热生效"的全部机制（配置读取都在
  property 访问时发生，构造时捕获的 settings 对象不再作数）。

安全口径：api_key 落盘只在本机 data/（gitignored），对外接口**只回掩码**，
不回明文 key；PUT 传空串视为"不修改"。
"""
import json
import os
import re
import threading

from app.config import get_settings

_LOCK = threading.Lock()
_cache: dict = {}
_loaded = False
_version = 0  # 进程内配置版本号：任何一次成功写入 +1，服务侧据此重建客户端

# TTS 默认值（v2.5/v2.8 原 tts_service 常量迁入，语义不变）
DEFAULT_TTS = {
    "voice_a": "zh-CN-YunxiNeural",    # 男主播（听书也用此声）
    "voice_b": "zh-CN-XiaoyiNeural",   # 女主播
    "rate": "+9%",                     # 播客语速（edge-tts rate 语法）
}

_VOICE_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]+){1,3}$")
_RATE_RE = re.compile(r"^[+-]\d{1,3}%$")


def _path() -> str:
    return os.path.join(get_settings().data_dir, "runtime_settings.json")


def _load_locked() -> dict:
    global _cache, _loaded
    if _loaded:
        return _cache
    _loaded = True
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        _cache = data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        _cache = {}
    return _cache


def _save_locked() -> None:
    path = _path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_cache, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def version() -> int:
    """当前配置版本号（进程内单调 +1）。服务侧记住构建时的值，访问时比对。"""
    return _version


def llm_config() -> dict:
    """生效的 LLM 配置 = 运行时覆盖 > .env。api_key 为空由调用方决定报错口径。"""
    s = get_settings()
    with _LOCK:
        rt = dict(_load_locked().get("llm") or {})
    return {
        "api_key": rt.get("api_key") or s.deepseek_api_key or "",
        "base_url": rt.get("base_url") or s.deepseek_base_url,
        "model": rt.get("model") or s.deepseek_model,
    }


def update_llm(base_url=None, model=None, api_key=None) -> None:
    """空串/None = 不修改；全部非法值（base_url 无协议）由路由层先拦。"""
    global _version
    with _LOCK:
        data = _load_locked()
        llm = data.setdefault("llm", {})
        if base_url:
            llm["base_url"] = base_url.strip().rstrip("/")
        if model:
            llm["model"] = model.strip()
        if api_key:
            llm["api_key"] = api_key.strip()
        _save_locked()
        _version += 1


def tts_config() -> dict:
    with _LOCK:
        rt = dict(_load_locked().get("tts") or {})
    cfg = dict(DEFAULT_TTS)
    for k in cfg:
        if rt.get(k):
            cfg[k] = rt[k]
    return cfg


def update_tts(voice_a=None, voice_b=None, rate=None) -> None:
    """校验失败抛 ValueError（路由层转 422）；不合法绝不落盘。"""
    global _version
    if voice_a is not None and not _VOICE_RE.match(voice_a.strip()):
        raise ValueError(f"音色 A 名称不合法：{voice_a}")
    if voice_b is not None and not _VOICE_RE.match(voice_b.strip()):
        raise ValueError(f"音色 B 名称不合法：{voice_b}")
    if rate is not None and not _RATE_RE.match(rate.strip()):
        raise ValueError(f"语速须形如 +9%/-10%：{rate}")
    with _LOCK:
        data = _load_locked()
        tts = data.setdefault("tts", {})
        if voice_a:
            tts["voice_a"] = voice_a.strip()
        if voice_b:
            tts["voice_b"] = voice_b.strip()
        if rate:
            tts["rate"] = rate.strip()
        _save_locked()
        _version += 1


# v3.7 批注导出：读书相关内容按慧姐规矩落独立 vault「什么书都有」，新建「读点书吧」文件夹
DEFAULT_EXPORT_DIR = os.path.join("~", "Documents", "Obsidian", "什么书都有", "读点书吧")


def export_config() -> dict:
    """生效的导出目录 = 运行时覆盖 > 默认 vault 路径；resolved 已展开 ~"""
    with _LOCK:
        rt = dict(_load_locked().get("export") or {})
    d = rt.get("obsidian_dir") or DEFAULT_EXPORT_DIR
    return {"obsidian_dir": d, "resolved": os.path.expanduser(d)}


def update_export(obsidian_dir=None) -> None:
    """校验失败抛 ValueError（路由层转 422）；空串=恢复默认目录。"""
    global _version
    if obsidian_dir is None:
        return
    v = obsidian_dir.strip()
    if v and not (v.startswith(("/", "~", ".")) or re.match(r"^[A-Za-z]:[\\/]", v)):
        raise ValueError(f"目录需为绝对路径或 ~ 开头：{v}")
    if len(v) > 300:
        raise ValueError("目录路径过长")
    with _LOCK:
        data = _load_locked()
        ex = data.setdefault("export", {})
        if v:
            ex["obsidian_dir"] = v
        else:
            ex.pop("obsidian_dir", None)
        _save_locked()
        _version += 1


def mask_key(key: str) -> str:
    """掩码展示：只留后 4 位；短 key 一律不给看尾巴。"""
    if not key:
        return ""
    return "••••" + key[-4:] if len(key) > 8 else "••••"
