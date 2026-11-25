from langchain_openai import ChatOpenAI
from app.services import settings_store


class AIService:
    """DeepSeek AI服务"""

    def __init__(self):
        self._llm = None  # 外部注入槽：测试打桩直注此属性，永远优先、绝不重建
        self._llm_built = None  # 属性自建的 ChatOpenAI（热生效只重建这个）
        self._llm_built_ver = -1

    @property
    def llm(self):
        """延迟初始化LLM；设置面板改过配置（版本变了）就重建。
        v3.5 教训：早期写法拿注入槽 _llm 直接比版本，测试注入的桩被
        无声换成真 ChatOpenAI，test_draft_flow 实锤跑了真模型。"""
        if self._llm is not None:
            return self._llm
        ver = settings_store.version()
        if self._llm_built is None or self._llm_built_ver != ver:
            cfg = settings_store.llm_config()
            if not cfg["api_key"]:
                raise ValueError("请配置DEEPSEEK_API_KEY环境变量或在设置面板填写 API Key")
            self._llm_built = ChatOpenAI(
                model=cfg["model"],
                openai_api_key=cfg["api_key"],
                openai_api_base=cfg["base_url"],
                # 内部 vLLM 推理模型须关思考，见 analysis_service 注释
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            self._llm_built_ver = ver
        return self._llm_built

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
