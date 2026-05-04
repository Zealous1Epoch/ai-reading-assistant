from langchain_openai import ChatOpenAI
from app.config import get_settings

settings = get_settings()


class AIService:
    """DeepSeek AI服务"""

    def __init__(self):
        self._llm = None

    @property
    def llm(self):
        """延迟初始化LLM"""
        if self._llm is None:
            if not settings.deepseek_api_key:
                raise ValueError("请配置DEEPSEEK_API_KEY环境变量")
            self._llm = ChatOpenAI(
                model=settings.deepseek_model,
                openai_api_key=settings.deepseek_api_key,
                openai_api_base=settings.deepseek_base_url,
            )
        return self._llm

    async def chat(self, message: str, context: str = "") -> str:
        """与AI对话"""
        if context:
            full_message = f"背景信息：\n{context}\n\n问题：{message}"
        else:
            full_message = message

        response = await self.llm.ainvoke(full_message)
        return response.content

    async def summarize(self, text: str) -> str:
        """总结文本"""
        prompt = f"请总结以下内容：\n\n{text}"
        response = await self.llm.ainvoke(prompt)
        return response.content

    async def answer_question(self, question: str, book_content: str) -> str:
        """基于书籍内容回答问题"""
        prompt = f"""基于以下书籍内容回答问题。

书籍内容：
{book_content}

问题：{question}

请提供准确、有帮助的回答："""
        response = await self.llm.ainvoke(prompt)
        return response.content


# 单例
ai_service = AIService()
