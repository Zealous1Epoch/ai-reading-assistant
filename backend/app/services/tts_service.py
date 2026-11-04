"""Edge-TTS 语音合成服务（v2.5 听书 + 播客）

edge-tts 走微软 Edge 在线神经网络语音——免费、无独立 key，**不依赖 DeepSeek 余额**。
- 章节听书：单声（男声云希）整章一个 mp3
- 播客：双主播按台词逐段合成拼接（A=云希 男 / B=晓伊 女），同码率 mp3 帧拼接可直接播放
缓存文件在 data/audio/，文件名 sha1(范围|书|章/主题|内容哈希)——内容没变重复合成直接命中。
"""
import hashlib
import json
import os
import re
from typing import List, Optional, Tuple

import edge_tts

from app.config import get_settings

settings = get_settings()

VOICE_A = "zh-CN-YunxiNeural"    # 男主播（听书也用此声）
VOICE_B = "zh-CN-XiaoyiNeural"   # 女主播
TTS_CHAR_CAP = 20000             # 听书单章合成字数上限（约 80+ 分钟语量，再长按上限截断）
PODCAST_CHARS_PER_MIN = 240      # 中文口播约 240 字/分钟，用于时长→字数换算
PODCAST_MINUTES = (10, 20, 30)   # 时长档


def audio_dir() -> str:
    d = os.path.join(settings.data_dir, "audio")
    os.makedirs(d, exist_ok=True)
    return d


# 需要剥掉的排版噪声：markdown 符号、分隔线、过多空白
_MD_LINE = re.compile(r"^\s*(#{1,6}\s*|>\s*|[-*+]\s+|\|.*\|\s*$)")
_MD_INLINE = re.compile(r"(\*\*|__|`|~~)")


def clean_for_tts(text: str, cap: int = TTS_CHAR_CAP) -> str:
    """正文 → 可朗读文本：剥 markdown、压空白；超上限截断并补口语化收尾"""
    lines = []
    for raw in (text or "").splitlines():
        line = _MD_INLINE.sub("", _MD_LINE.sub("", raw)).strip()
        if line in ("---", "***", "___"):
            continue
        lines.append(line)
    out = re.sub(r"\n{2,}", "\n", "\n".join(lines)).strip()
    if len(out) > cap:
        out = out[:cap].rstrip() + "\n（本章剩余内容较长，本次朗读到这里，您可以继续阅读文字版。）"
    return out


def _sha1(*parts: str) -> str:
    h = hashlib.sha1()
    h.update("|".join(parts).encode("utf-8"))
    return h.hexdigest()


def chapter_audio_name(book_id: str, chapter_id: str, spoken_text: str) -> str:
    """章名含正文哈希：重切章/改内容后自动重合成，未变则命中缓存"""
    return _sha1("chapter", book_id, chapter_id, _sha1(spoken_text)) + ".mp3"


def podcast_audio_name(book_id: str, topic: str, minutes: int, script_json: str) -> str:
    return _sha1("podcast", book_id, topic, str(minutes), _sha1(script_json)) + ".mp3"


async def synth_one(text: str, voice: str, path: str) -> None:
    """整段文本合成到一个 mp3（edge-tts 内部自行分段）"""
    await edge_tts.Communicate(text=text, voice=voice).save(path)


async def stream_synth(lines: List[Tuple[str, str]], path: str):
    """逐条 (text, voice) 合成并顺序写入同一文件（mp3 帧拼接）。
    异步生成器：每完成一段 yield (已完成数, 总数) 供调用方发进度帧；
    消费到耗尽时原子落盘。"""
    tmp = path + ".part"
    total = len(lines)
    with open(tmp, "wb") as f:
        for i, (text, voice) in enumerate(lines):
            com = edge_tts.Communicate(text=text, voice=voice)
            async for chunk in com.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
            yield i + 1, total
    os.replace(tmp, path)


def lines_from_obj(obj) -> Optional[List[Tuple[str, str]]]:
    """台本对象 {"lines":[{"s","t"}]} → [(text, voice)]；s 容错 A/B/男/女；无有效台词 None"""
    if not isinstance(obj, dict):
        return None
    arr = obj.get("lines")
    if not isinstance(arr, list):
        return None
    out: List[Tuple[str, str]] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        text = str(item.get("t") or "").strip()
        if not text:
            continue
        s = str(item.get("s") or "A").strip().upper()
        voice = VOICE_B if ("B" in s or "女" in s) else VOICE_A
        out.append((text, voice))
    return out or None


def parse_podcast_script(raw: str) -> Optional[List[Tuple[str, str]]]:
    """从模型原始输出解析播客台本 → [(text, voice)]（容忍围栏/前后杂话）；失败 None。
    routers/tools 走 _llm_json 得到 dict 时用 lines_from_obj，此函数留给直连文本场景。"""
    t = (raw or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    m = re.search(r"\{.*\}", t, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    return lines_from_obj(obj)


def script_json(lines: List[Tuple[str, str]]) -> str:
    """台本序列化（用于缓存名哈希与资产记录）"""
    return json.dumps(
        [{"s": "B" if v == VOICE_B else "A", "t": t} for t, v in lines],
        ensure_ascii=False)
