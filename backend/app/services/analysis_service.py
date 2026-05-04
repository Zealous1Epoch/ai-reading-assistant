"""
AI分析服务 - 深度分析书籍内容
支持论点提炼、杠精视角提问、对话总结
"""

import json
from typing import AsyncGenerator, Optional
from langchain_openai import ChatOpenAI
from langchain.schema import HumanMessage, SystemMessage, AIMessage

from app.config import get_settings

settings = get_settings()


class AnalysisService:
    """AI分析服务"""

    def __init__(self):
        self._llm = None
        self._streaming_llm = None

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
                temperature=0.7,
            )
        return self._llm

    @property
    def streaming_llm(self):
        """流式输出LLM"""
        if self._streaming_llm is None:
            if not settings.deepseek_api_key:
                raise ValueError("请配置DEEPSEEK_API_KEY环境变量")
            self._streaming_llm = ChatOpenAI(
                model=settings.deepseek_model,
                openai_api_key=settings.deepseek_api_key,
                openai_api_base=settings.deepseek_base_url,
                temperature=0.7,
                streaming=True,
            )
        return self._streaming_llm

    async def analyze_chapter(self, chapter_content: str, chapter_title: str) -> dict:
        """
        深度分析章节内容

        返回：
        - 论点论据提炼
        - 杠精视角提问
        - 对话总结（含思维漏洞分析）
        """

        system_prompt = """你是一个深度阅读分析专家，擅长批判性思维和内容洞察。
请从以下三个维度分析给定的章节内容：

## 一、论点论据提炼
请提炼出本章的核心论点和支撑论据（无序列表格式）

## 二、杠精视角提问
请从"杠精/产品经理/批判者"的视角，针对内容提出3-5个尖锐但有价值的问题：
- 挑战作者的假设
- 指出逻辑漏洞
- 提出反例或边界情况
- 追问"真的是这样吗？"

## 三、对话式总结
用一段自然对话的方式总结本章内容，包含：
- 核心观点概述
- 思维漏洞或局限性分析
- 值得深思的点

请用JSON格式输出，结构如下：
{
    "arguments": ["论点1", "论点2", ...],
    "evidences": ["论据1", "论据2", ...],
    "critical_questions": [
        {"question": "问题1", "perspective": "视角说明"},
        ...
    ],
    "summary": {
        "main_point": "核心观点",
        "blind_spots": ["漏洞1", "漏洞2"],
        "insights": ["洞察1", "洞察2"]
    }
}"""

        user_prompt = f"""章节标题：{chapter_title}

章节内容：
{chapter_content[:8000]}

请按照要求进行深度分析，直接输出JSON格式结果。"""

        try:
            response = await self.llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt)
            ])

            # 解析JSON
            content = response.content
            # 提取JSON部分
            import re
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                return json.loads(json_match.group())
            else:
                return {"error": "无法解析分析结果", "raw": content}

        except Exception as e:
            return {"error": str(e)}

    async def stream_chat(
        self,
        message: str,
        chapter_context: Optional[str] = None,
        chat_history: Optional[list] = None
    ) -> AsyncGenerator[str, None]:
        """
        流式对话

        :param message: 用户消息
        :param chapter_context: 当前章节上下文
        :param chat_history: 历史对话记录
        """

        system_prompt = """你是一个专业的智能读书助手，擅长深度分析和清晰表达。

你的回答风格会根据内容自动调整：
- 面对神学、护教学、学术论证类内容 → 采用严谨的学术风格，引用具体章节、论据和出处
- 面对生活、婚姻、工作、心理类内容 → 采用通俗易懂的讲解风格，帮助用户深入理解

核心要求：
1. 回答必须具体、详细，提供充分的论据和证据链。当用户要求论证某个观点时，请分层展开论述，引用书中具体内容
2. 善于引用具体内容进行分析，能发现作者的隐含假设，敢于提出批判性观点
3. 回答时条理清晰，用分层结构展开：先给出核心结论，再展开论据，最后总结

格式规则：
1. 请用纯文本回复，不要使用任何Markdown格式符号（如#、*、`等）。
2. 当引用某个来源时，请用「《书名》·章节名」的格式明确标注出处。
3. 如果上下文中有多本书的信息，请对比它们的观点差异。
4. 需要列出内容时可以使用无序列表（用 - 开头即可）。
5. 重要：当被问到"证据"、"论据"、"证明"、"证实"类问题时，必须提供至少3个具体论据或角度，每个论附上来源。"""

        # 附加清理指令（追加到用户消息之后，作为 reminders）
        cleanup_reminder = "\n\n（请勿使用Markdown格式。引用来源时请用「《书名》·章节名」格式。）"

        messages = [SystemMessage(content=system_prompt)]

        # 添加章节上下文
        if chapter_context:
            context_msg = f"[参考内容]\n{chapter_context[:4000]}\n\n请基于以上内容回答用户问题。引用时请标注来源。"
            messages.append(HumanMessage(content=context_msg))
            messages.append(SystemMessage(content="好的，我已了解参考内容，会标注来源。请提问。"))

        # 添加历史对话
        if chat_history:
            for msg in chat_history[-6:]:  # 最近3轮对话
                if msg["role"] == "user":
                    messages.append(HumanMessage(content=msg["content"]))
                else:
                    messages.append(AIMessage(content=msg["content"]))

        # 添加当前问题
        messages.append(HumanMessage(content=message + cleanup_reminder))

        try:
            async for chunk in self.streaming_llm.astream(messages):
                if chunk.content:
                    yield chunk.content
        except Exception as e:
            yield f"\n[错误] {str(e)}"

    async def generate_chapter_summary(self, title: str, content: str) -> dict:
        """
        生成章节摘要和关键词

        返回: {"summary": "摘要内容", "keywords": ["关键词1", "关键词2", ...]}
        """
        system_prompt = """你是一个专业的书籍摘要生成器。请为给定的章节生成：
1. 一段简洁的摘要（100-200字），概括本章核心内容和论点
2. 3-5个关键词，反映本章主题

请用JSON格式输出，结构如下：
{
    "summary": "摘要内容...",
    "keywords": ["关键词1", "关键词2", "关键词3"]
}"""

        user_prompt = f"""章节标题：{title}

章节内容：
{content[:5000]}"""

        try:
            response = await self.llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt)
            ])

            import re
            json_match = re.search(r'\{[\s\S]*\}', response.content)
            if json_match:
                result = json.loads(json_match.group())
                return {
                    "summary": result.get("summary", "暂无摘要"),
                    "keywords": result.get("keywords", [])
                }
            return {"summary": "无法生成摘要", "keywords": []}
        except Exception as e:
            return {"summary": f"生成摘要失败: {str(e)}", "keywords": []}

    async def quick_analysis(self, text: str, analysis_type: str = "summary") -> str:
        """
        快速分析功能

        :param text: 待分析文本
        :param analysis_type: 分析类型 (summary/key_points/critique)
        """

        prompts = {
            "summary": "请用简洁的语言总结以下内容的核心观点（100字以内）：\n\n",
            "key_points": "请提取以下内容的3-5个关键点（每点不超过20字）：\n\n",
            "critique": "请从批判性思维角度，指出以下内容的1-2个潜在问题或局限性：\n\n",
        }

        if analysis_type not in prompts:
            analysis_type = "summary"

        prompt = prompts[analysis_type] + text[:2000]

        try:
            response = await self.llm.ainvoke([HumanMessage(content=prompt)])
            return response.content
        except Exception as e:
            return f"分析失败: {str(e)}"


# 单例
analysis_service = AnalysisService()
