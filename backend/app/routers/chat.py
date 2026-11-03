from fastapi import APIRouter, HTTPException
from app.models.schemas import ChatRequest, ChatResponse
from app.services.ai_service import ai_service
from app.services.book_processor import book_processor

router = APIRouter(prefix="/chat", tags=["聊天"])


@router.post("/", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """与AI助手聊天（RAG增强：自动检索相关章节）"""
    try:
        # 构建 context：优先用传入的 context，其次用 RAG 检索
        rag_context = ""
        if request.book_ids:
            # RAG 检索相关章节
            results = await book_processor.search_chapters(
                query=request.message,
                book_ids=request.book_ids,
                n_results=3
            )
            if results:
                context_parts = []
                for r in results:
                    context_parts.append(
                        f"【{r.title}】\n{r.content_snippet}"
                    )
                rag_context = "\n\n---\n\n".join(context_parts)

        # 合并 context：传入的 context 优先，RAG 检索作为补充
        if request.context:
            final_context = request.context
            if rag_context:
                final_context = f"{rag_context}\n\n---\n\n补充背景：\n{request.context}"
        else:
            final_context = rag_context

        response = await ai_service.chat(
            message=request.message,
            context=final_context
        )
        return ChatResponse(response=response)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
