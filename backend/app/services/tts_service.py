"""Edge-TTS 语音合成服务（v2.5 听书 + 播客）

edge-tts 走微软 Edge 在线神经网络语音——免费、无独立 key，**不依赖 DeepSeek 余额**。
- 章节听书：单声（男声云希）整章一个 mp3
- 播客：双主播按台词逐段合成拼接（A=云希 男 / B=晓伊 女），同码率 mp3 帧拼接可直接播放
缓存文件在 data/audio/，文件名 sha1(范围|书|章/主题|内容哈希)——内容没变重复合成直接命中。
"""
import asyncio
import hashlib
import json
import os
import re
from typing import List, Optional, Tuple

import edge_tts

from app.config import get_settings
from app.services import settings_store

settings = get_settings()


# v3.5 设置面板：音色/语速可在运行时改（settings_store.tts_config），下列函数是
# 唯一取用口径——旧常量已退役，勿再直接引用（改了也不会生效的假配置最坑）。
def voice_a() -> str:
    return settings_store.tts_config()["voice_a"]


def voice_b() -> str:
    return settings_store.tts_config()["voice_b"]


def podcast_rate() -> str:
    return settings_store.tts_config()["rate"]


VOICE_A = "zh-CN-YunxiNeural"    # 默认男主播（兼容保留；取用一律走 voice_a()）
VOICE_B = "zh-CN-XiaoyiNeural"   # 默认女主播（兼容保留；取用一律走 voice_b()）
TTS_CHAR_CAP = 20000             # 听书单章合成字数上限（约 80+ 分钟语量，再长按上限截断）
PODCAST_CHARS_PER_MIN = 280     # LLM 实测生效语速约 280 字/分钟（含 +9% 语速与句间停顿），用于时长→字数换算
PODCAST_MINUTES = (10, 20, 30)   # 时长档
TTS_CONCURRENCY = 4              # v2.8-A：播客段级并发上限（微软端有瞬时限流，4 路是稳妥值）
PODCAST_RATE = "+9%"             # v2.8-C：播客语速微增，贴近真实对谈节奏，顺带压缩成片时长

# v2.8-C：句间微停顿。本机无 ffmpeg，静音 MP3 帧直接按规范构造（与 edge-tts 实测输出
# 同参数：MPEG-2 LSF Layer III、48kbps、24kHz、mono、无CRC；LSF 帧长=72*br/sr=144B，
# 每帧 576 样本=24ms）。side info 全零 → part2_3_length=0 → 解码为纯静音。
# 已验证：afinfo 识别时长 264ms；混入真实 edge-tts 帧后反解码 51 块=20+11+20、
# 静音区样本峰值 0（帧拼接语义与播放器等价）。
_GAP_FRAME = bytes([0xFF, 0xF3, 0x64, 0xC0]) + bytes(140)
PODCAST_GAP_BYTES = _GAP_FRAME * 11   # ≈264ms，双主播轮次的呼吸感


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
    """章名含正文哈希：重切章/改内容后自动重合成，未变则命中缓存。
    v3.5：键带上音色——设置面板换声后旧 mp3 不再误命中（旧文件沦为孤儿无害）。"""
    return _sha1("chapter", "v2", voice_a(), book_id, chapter_id, _sha1(spoken_text)) + ".mp3"


def podcast_audio_name(book_id: str, topic: str, minutes: int, nonce: str = "") -> str:
    """v2.8-B 缓存语义修正：键 = 书+主题+时长。v2.5 曾把台本哈希拼进键——LLM 每次都
    重写台本，重跑必不命中，缓存形同虚设。"同一期节目"由用户意图（书/主题/时长）
    决定而非字节。    nonce 供"重新生成一期"（regen）另起新文件名，不覆盖旧期；
    版本前缀与 v2.5 旧键（含台本哈希）区隔——v3 起音频带语速与句间停顿，再 bump 一次；
    v4（v3.5 设置面板）把双主播音色与语速并进键，改配置后新一期不蹭旧声缓存。"""
    return _sha1("podcast", "v4", voice_a(), voice_b(), podcast_rate(),
                 book_id, topic, str(minutes), nonce) + ".mp3"


async def synth_one(text: str, voice: str, path: str) -> None:
    """整段文本合成到一个 mp3（edge-tts 内部自行分段）"""
    await edge_tts.Communicate(text=text, voice=voice).save(path)


async def stream_synth(lines: List[Tuple[str, str]], path: str,
                       rate: Optional[str] = None, gap: bytes = b""):
    """分段并发合成、按台词顺序落盘（mp3 帧拼接）。
    v2.8-A 由串行改 4 路并发：串行实测 ~3s/段、30 分钟档要等近 5 分钟，瓶颈全在
    逐段等微软往返；并发把等待重叠起来，墙钟约缩 4 倍。所有防线原样保留——
    段级 3 次重试、单段字节先进内存、**整段成功才收**（若 stream 块直写共享
    句柄，中途失败重试会在成品里混入半段脏字节：mp3 帧拼接下表现为爆音或拒播，
    无异常抛出、静默劣化最难查），全部成功后才按台词顺序拼字节原子落盘。
    代价是整片内存缓冲（30 分钟档 ~10MB 量级，可接受）。
    v2.8-C：rate 透传 edge-tts 语速（如 "+9%"）；gap 为段间插入的静音字节
    （仅段间，不在片头片尾），给双主播轮次呼吸感。
    异步生成器：每完成一段 yield (已完成数, 总数)——完成序≠台词序，进度计数语义不变。"""
    tmp = path + ".part"
    total = len(lines)
    sem = asyncio.Semaphore(TTS_CONCURRENCY)
    bufs: List[Optional[bytes]] = [None] * total
    errs: List[Optional[Exception]] = [None] * total
    finished: asyncio.Queue = asyncio.Queue()

    async def _one(i: int, text: str, voice: str) -> None:
        async with sem:
            last_err: Optional[Exception] = None
            for attempt in range(3):  # 首次 + 2 次重试：edge-tts 偶发 "No audio was received"
                buf = bytearray()
                try:
                    comm = edge_tts.Communicate(text=text, voice=voice, rate=rate) if rate \
                        else edge_tts.Communicate(text=text, voice=voice)
                    async for chunk in comm.stream():
                        if chunk["type"] == "audio":
                            buf.extend(chunk["data"])
                    bufs[i] = bytes(buf)
                    last_err = None
                    break
                except Exception as e:  # noqa: BLE001 — edge-tts 异常类型杂，一律按段重试
                    last_err = e
                    if attempt < 2:
                        await asyncio.sleep(1.0)
            if last_err is not None:
                errs[i] = last_err
            await finished.put(i)

    tasks = [asyncio.ensure_future(_one(i, t, v)) for i, (t, v) in enumerate(lines)]
    done = 0
    try:
        while done < total:
            await finished.get()
            done += 1
            yield done, total
        first_err = next((e for e in errs if e is not None), None)
        if first_err is not None:  # 任何一段三试仍失败 → 整片不落盘，调用方报错
            raise first_err
        with open(tmp, "wb") as f:
            for i, b in enumerate(bufs):
                if i and gap:  # v2.8-C：仅段间插静音，片头片尾不加
                    f.write(gap)
                f.write(b or b"")
        os.replace(tmp, path)
    finally:
        for tk in tasks:  # 出错或消费方提前断开（SSE 断连）时收敛仍在跑的任务
            if not tk.done():
                tk.cancel()


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
        voice = voice_b() if ("B" in s or "女" in s) else voice_a()
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


def validate_script(lines: List[Tuple[str, str]], target_chars: int) -> List[str]:
    """v2.8-D 台本规则审核：返回问题清单（空 = 通过）。规则与 _podcast 提示词硬要求对齐，
    问题描述会被拼回提示词驱动 LLM 定向重写：
    - 段数不足（按平均单条 ≤200 字估下限）→ 大概率是 LLM 偷工产出提纲式短稿
    - 总字数 < 目标 60% → "腰斩"（调用方对此硬失败，宁可报错不发错时长货）
    - 总字数 > 目标 135% → 远超 1.2 倍收尾线
    - 单条 > 120 字 → 违背短句口语要求，朗读必然上气不接下气
    - 同人连说占比 > 20% → 未严格交替"""
    issues: List[str] = []
    n = len(lines)
    total = sum(len(t) for t, _ in lines)
    min_lines = max(6, target_chars // 200)
    if n < min_lines:
        issues.append(f"台本只有 {n} 段，至少应有 {min_lines} 段才撑得起约 {target_chars // PODCAST_CHARS_PER_MIN} 分钟")
    if total < target_chars * 0.6:
        issues.append(f"全篇台词约 {total} 字，不足目标 {target_chars} 字的六成，内容明显被压缩")
    if total > target_chars * 1.35:
        issues.append(f"全篇台词约 {total} 字，超出目标 {target_chars} 字过多，须在 1.2 倍内妥善收尾")
    over = [t for t, _ in lines if len(t) > 120]
    if over:
        issues.append(f"有 {len(over)} 条台词超过 120 字（例：{over[0][:24]}……），须拆成两条")
    if n >= 4:
        same = sum(1 for i in range(1, n) if lines[i][1] == lines[i - 1][1])
        if same > max(2, int((n - 1) * 0.2)):
            issues.append("主播 A/B 未严格交替发言，请修正说话人 s 标注")
    return issues


def script_json(lines: List[Tuple[str, str]]) -> str:
    """台本序列化（用于缓存名哈希与资产记录）"""
    return json.dumps(
        [{"s": "B" if v == voice_b() else "A", "t": t} for t, v in lines],
        ensure_ascii=False)
