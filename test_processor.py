#!/usr/bin/env python3
"""
书籍处理器测试脚本
用于测试智能章节切分功能
"""

import asyncio
import sys
import os

# 添加 backend 目录到路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))

from app.services.book_processor import BookProcessor
from app.config import get_settings


async def test_with_sample_text():
    """使用示例文本测试章节识别"""

    print("=" * 60)
    print("测试1: AI章节识别功能")
    print("=" * 60)

    # 模拟书籍开头文本
    sample_text = """
    目录

    第一章 引言 1
    1.1 研究背景 3
    1.2 研究目的 5

    第二章 文献综述 8
    2.1 国内研究现状 10
    2.2 国外研究现状 15

    第三章 研究方法 20
    3.1 定性研究方法 22
    3.2 定量研究方法 25

    第四章 实验设计 30

    第五章 结论与展望 40
    """

    processor = BookProcessor()

    print("\n正在使用AI识别目录结构...")
    print("（需要配置 DEEPSEEK_API_KEY）\n")

    try:
        toc_items = await processor.detect_toc_by_ai(sample_text)

        print("识别到的目录结构：")
        print("-" * 40)
        for item in toc_items:
            indent = "  " * (item.level - 1)
            print(f"{indent}• {item.title}")

        print(f"\n共识别 {len(toc_items)} 个章节")

    except ValueError as e:
        print(f"⚠️  错误: {e}")
        print("请确保已配置 DEEPSEEK_API_KEY 环境变量")


async def test_chapter_split():
    """测试章节切分功能"""

    print("\n" + "=" * 60)
    print("测试2: 章节切分功能")
    print("=" * 60)

    full_text = """
    第一章 引言

    本书旨在探讨人工智能技术在现代社会中的应用与挑战。随着科技的飞速发展，
    人工智能已经渗透到我们生活的方方面面。本章将介绍研究背景和主要研究内容。

    1.1 研究背景

    近年来，深度学习技术取得了突破性进展。从图像识别到自然语言处理，
    AI正在改变各个行业的运作方式。

    1.2 研究目的

    本研究旨在探索AI技术在教育领域的应用可能性。

    第二章 文献综述

    本章回顾了相关领域的研究成果和发展历程。

    2.1 国内研究现状

    国内学者在AI教育应用方面进行了大量研究...

    2.2 国外研究现状

    国际上，个性化学习系统已经得到广泛应用...

    第三章 研究方法

    本研究采用混合研究方法，结合定性和定量分析。

    第四章 结论

    本研究得出以下结论：人工智能技术将在教育领域发挥越来越重要的作用。
    """

    processor = BookProcessor()

    # 使用降级方案（正则匹配）
    print("\n使用正则匹配检测章节...")

    toc_items = processor._fallback_toc_detection(full_text)

    print(f"\n检测到 {len(toc_items)} 个章节标题：")
    for item in toc_items:
        print(f"  - {item.title}")

    # 切分章节
    chapters = processor.split_by_toc(full_text, toc_items)

    print(f"\n切分为 {len(chapters)} 个章节：")
    print("-" * 40)

    for ch in chapters:
        print(f"\n章节 {ch.chapter_index + 1}: {ch.title}")
        print(f"  字数: {ch.word_count}")
        print(f"  内容预览: {ch.content[:100]}...")


def test_chromadb():
    """测试ChromaDB连接"""

    print("\n" + "=" * 60)
    print("测试3: ChromaDB 向量数据库")
    print("=" * 60)

    try:
        processor = BookProcessor()
        print(f"\n✅ ChromaDB 初始化成功")
        print(f"   集合名称: {processor.collection.name}")
        print(f"   存储路径: {processor.persist_directory}")

        # 检查现有数据
        count = processor.collection.count()
        print(f"   已存储章节: {count} 条")

    except Exception as e:
        print(f"❌ ChromaDB 初始化失败: {e}")


async def main():
    """运行所有测试"""
    print("\n📚 智能读书助手 - 书籍处理器测试\n")

    settings = get_settings()

    print("环境配置:")
    print(f"  - API Key: {'已配置 ✅' if settings.deepseek_api_key else '未配置 ⚠️'}")
    print(f"  - API URL: {settings.deepseek_base_url}")

    # 测试ChromaDB
    test_chromadb()

    # 测试章节切分
    await test_chapter_split()

    # 测试AI章节识别（需要API Key）
    if settings.deepseek_api_key:
        await test_with_sample_text()
    else:
        print("\n" + "=" * 60)
        print("提示: 配置 DEEPSEEK_API_KEY 后可测试AI章节识别功能")
        print("=" * 60)

    print("\n✅ 测试完成！\n")


if __name__ == "__main__":
    asyncio.run(main())
