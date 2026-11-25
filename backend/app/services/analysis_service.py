"""
AI分析服务 - 深度分析书籍内容
支持论点提炼、杠精视角提问、对话总结
"""

import json
from typing import AsyncGenerator, Optional
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

from app.config import get_settings
from app.services import settings_store

settings = get_settings()


class AnalysisService:
    """AI分析服务"""

    def __init__(self):
        self._llm = None
        self._streaming_llm = None
        # v3.5 热生效：记住各自构建时的配置版本号，设置面板一改（版本 bump）就重建
        self._llm_built = None
        self._llm_built_ver = -1
        self._streaming_built = None
        self._streaming_built_ver = -1

    @property
    def llm(self):
        """延迟初始化LLM"""
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
                temperature=0.7,
                # 内部 vLLM 部署（qwen 系推理模型）必须关思考：平铺 enable_thinking 会被
                # 忽略，只认 chat_template_kwargs 嵌套写法，否则思考吃满 max_tokens
                # 导致 JSON 腰斩（招聘系统 2026-10-16 事故教训）
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            self._llm_built_ver = ver
        return self._llm_built

    @property
    def streaming_llm(self):
        """流式输出LLM"""
        if self._streaming_llm is not None:
            return self._streaming_llm
        ver = settings_store.version()
        if self._streaming_built is None or self._streaming_built_ver != ver:
            cfg = settings_store.llm_config()
            if not cfg["api_key"]:
                raise ValueError("请配置DEEPSEEK_API_KEY环境变量或在设置面板填写 API Key")
            self._streaming_built = ChatOpenAI(
                model=cfg["model"],
                openai_api_key=cfg["api_key"],
                openai_api_base=cfg["base_url"],
                temperature=0.7,
                streaming=True,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            self._streaming_built_ver = ver
        return self._streaming_built

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
        chat_history: Optional[list] = None,
        system_prompt_override: Optional[str] = None,
        citation_instruction: Optional[str] = None
    ) -> AsyncGenerator[str, None]:
        """
        流式对话

        :param message: 用户消息
        :param chapter_context: 当前章节上下文
        :param chat_history: 历史对话记录
        :param system_prompt_override: 专家模式方法论系统提示词；传入则替换默认读书助手人格
        :param citation_instruction: 句内引用编号规则；传入则追加到系统提示词末尾（对默认人格与专家人格一致生效）
        """

        system_prompt = system_prompt_override or """你是读者的读书同伴，帮他读懂原书——最高优先级是下面的引导律，一切"回答要详细"的要求都在它之后、且只在展开答案时生效。目的是辅助阅读，不是让读者习惯伸手要答案。

引导律（对问题默分两类，但绝不在回复里说出类别名）：
- 甲类（答案就写在原文表面上：人名、事件、术语定义、"作者在某章说了什么"）→ 直接回答并标注出处，不要绕圈子卖关子。
- 乙类（要读者自己想过才有收获：为什么、怎么论证、这说法对不对、和××怎么联系）→ 第一条回复只做"指路+反问"：一句方向性提示，指出该去原文哪一处看（用「《书名》·章节名」并点明段落特征，参考段落带编号时附 [n]），然后反问读者一个具体问题请他说看法。第一条回复里不许出现这道题的结论——即使你已经检索到了答案，也要忍住不给。
推进节奏：读者给出了自己的理解（哪怕答错）→ 先简短回应他的说法（哪里想对了、偏在哪），再展开完整回答，让读者把自己的思考与作者原意对起来；被同一问题连续追问到第二轮、或读者明说"直接告诉我答案"→ 直接展开，照办，但答案末尾留一个值得继续想的问题。

回答风格随内容自动调整：神学、护教学、学术论证类 → 严谨学术风，引用具体章节与出处；生活、婚姻、工作、心理类 → 通俗讲解风。

核心要求（仅在"展开完整回答"的那些回合适用）：
1. 具体、详细，提供充分的论据和证据链；被要求论证观点时分层展开，引用书中具体内容
2. 善于引用具体内容进行分析，能发现作者的隐含假设，敢于提出批判性观点
3. 条理清晰：先给出核心结论，再展开论据，最后总结

格式规则：
1. 请用纯文本回复，不要使用任何Markdown格式符号（如#、*、`等）。
2. 当引用某个来源时，请用「《书名》·章节名」的格式明确标注出处；若参考段落带有 [n] 编号，句末必须同时附上该编号（如 [1][3]）。
3. 如果上下文中有多本书的信息，请对比它们的观点差异。
4. 需要列出内容时可以使用无序列表（用 - 开头即可）。
5. 重要：当被问到"证据"、"论据"、"证明"、"证实"类问题时，必须提供至少3个具体论据或角度，每个论附上来源。
6. 硬性禁令（只约束开场格式，不改变引导律的推进节奏）：回复必须直接以原文位置、方向提示或向读者的提问起笔——"这是一个……的问题""我先不给你答案""让我来帮你""接下来我会"之类交代式开头一律不许出现，也不要提及你对问题的分类。特别注意：对乙类问题（为什么/怎么论证/对不对/怎么联系），第一条回复仍然只做"指路+反问"，不许因为这条禁令就顺路展开完整答案。"""

        # 句内引用编号规则：默认人格与专家人格一致追加
        if citation_instruction:
            system_prompt = system_prompt + citation_instruction

        # 附加清理指令（追加到用户消息之后，作为 reminders）
        cleanup_reminder = "\n\n（请勿使用Markdown格式。引用来源时请用「《书名》·章节名」格式，参考段落带编号时句末必附 [n]。）"

        messages = [SystemMessage(content=system_prompt)]

        # 添加章节上下文
        if chapter_context:
            context_msg = f"[参考内容]\n{chapter_context[:4000]}\n\n请基于以上内容回答用户问题。引用时请标注来源。若参考内容与问题明显无关，请先说明书中未涉及该主题，不要勉强引用无关内容。"
            messages.append(HumanMessage(content=context_msg))
            # 必须是 AIMessage 而非 SystemMessage：内部 vLLM 严格校验"system 消息只能在
            # 首位"，中位 SystemMessage 会 400（DeepSeek 此前容忍所以没暴露）
            messages.append(AIMessage(content="好的，我已了解参考内容，会标注来源。请提问。"))

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
