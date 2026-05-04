from fastapi import APIRouter, HTTPException
from app.models.schemas import ChatRequest, ChatResponse
from app.services.ai_service import ai_service

router = APIRouter(prefix="/chat", tags=["聊天"])


@router.post("/", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """与AI助手聊天"""
    try:
        response = await ai_service.chat(
            message=request.message,
            context=request.context or ""
        )
        return ChatResponse(response=response)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
