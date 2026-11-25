"""章节听书路由（v2.5）：整章 mp3 异步合成 + 任务轮询 + 文件服务

edge-tts 合成整章需要几十秒到几分钟，不能占用请求：
- POST /audio/chapter → 命中缓存直接 done；否则建任务后台合成，返回 task_id
- GET  /audio/task/{id} → 轮询 {status: running|done|error, url|error}
- GET  /audio/file/{name} → mp3（文件名限定 40 位 hex，防路径穿越）
听书完全不走 DeepSeek，账号欠费也可用。
"""
import asyncio
import os
import re
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services import tts_service
from app.services.book_processor import book_processor

router = APIRouter(prefix="/audio", tags=["听书"])

# 任务表：内存即可（单进程 uvicorn；重启丢任务无妨——成品 mp3 在磁盘，重新请求即命中缓存）
_TASKS: dict = {}

_SAFE_NAME = re.compile(r"^[0-9a-f]{40}\.mp3$")


class ChapterAudioRequest(BaseModel):
    book_id: str
    chapter_id: str


def _url(name: str) -> str:
    return f"/audio/file/{name}"


async def _run_chapter_task(task_id: str, spoken: str, path: str, name: str) -> None:
    task = _TASKS.get(task_id)
    if not task:
        return
    try:
        await tts_service.synth_one(spoken, tts_service.voice_a(), path)
        task.update(status="done", url=_url(name))
    except Exception as e:  # edge-tts 网络抖动等
        task.update(status="error", error=f"合成失败：{e}")


@router.post("/chapter")
async def start_chapter_audio(request: ChapterAudioRequest):
    chapter = book_processor.get_chapter_by_id(request.chapter_id)
    if not chapter or chapter.book_id != request.book_id:
        raise HTTPException(status_code=404, detail="找不到该章节")
    spoken = tts_service.clean_for_tts(chapter.content or "")
    if not spoken:
        raise HTTPException(status_code=400, detail="本章没有可朗读的内容")
    name = tts_service.chapter_audio_name(request.book_id, request.chapter_id, spoken)
    path = f"{tts_service.audio_dir()}/{name}"
    if os.path.exists(path):
        return {"status": "done", "url": _url(name), "cached": True}
    task_id = uuid.uuid4().hex[:12]
    _TASKS[task_id] = {"status": "running", "progress": "正在合成语音"}
    asyncio.get_running_loop().create_task(
        _run_chapter_task(task_id, spoken, path, name))
    return {"task_id": task_id, "status": "running"}


@router.get("/task/{task_id}")
async def chapter_audio_task(task_id: str):
    task = _TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在（服务可能已重启，请重新点击）")
    return task


@router.get("/file/{filename}")
async def audio_file(filename: str):
    if not _SAFE_NAME.match(filename):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = f"{tts_service.audio_dir()}/{filename}"
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="音频不存在")
    return FileResponse(path, media_type="audio/mpeg")
