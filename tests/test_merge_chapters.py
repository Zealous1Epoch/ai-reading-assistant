"""v3.8.1 章节合并（核对弹窗"合并按钮"）后端语义测试。

零 LLM：R11 重影在 RESEG_TRIGGERS 内会触发 AI 重切，BrokenLLM 抛错后
降级保留原切章——与 test_draft_flow_api 同一条已验证路径。
chroma/索引/草稿全部落在 tmp_path，不碰真实 backend/data。
"""

import asyncio

import pytest
from fastapi import HTTPException

from app.models.book_models import Chapter
from app.services.book_processor import BookProcessor
from app.services import draft_store
from app.routers import book_processor as bp
from app.routers.book_processor import CommitBody

from test_draft_flow_api import Env, BrokenLLM, ImmediateTasks, env  # noqa: F401  复用打桩件+env fixture（tests/ 在 sys.path）


# R11 same_num_title 形态：章号相等（阿拉伯 vs 汉字）且剥章号题面相等，
# 但整串标题不等——正好用来验证"合并后标题取正文最长成员"
FRAG1 = "章节页\n\n\n" + "重影片段" * 60                 # ~560 字（短，章节页碎片）
MAIN1 = "第一章正文 " + "废话生活" * 300               # ~1800+ 字（正文最长者）
CH2 = "第二章正文 " + "废话仁爱" * 300
FRAG3 = "章节页\n\n\n" + "重影片段" * 50
MAIN3 = "第三章正文 " + "废话权柄" * 280


def ghost_split(full_text, toc):
    def c(i, cid, title, content, s, e):
        return Chapter(chapter_id=cid, book_id="", title=title, content=content,
                       word_count=len(content), chapter_index=i,
                       start_position=s, end_position=e)
    return [
        c(0, "m-1", "第1章 面罩", FRAG1, 100, 600),
        c(1, "m-2", "第一章 面罩", MAIN1, 601, 3000),
        c(2, "m-3", "第二章 别的", CH2, 3001, 5000),
        c(3, "m-4", "第3章 又一面罩", FRAG3, 5001, 5400),
        c(4, "m-5", "第三章 又一面罩", MAIN3, 5401, 7000),
    ]


def run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def draft(env, monkeypatch):
    """重影书落草稿 → (env, book_id)"""
    monkeypatch.setattr(bp.book_processor, "split_by_toc", ghost_split)

    async def setup():
        up = await env.upload("随便什么正文内容" * 80)
        status = await env.analyze(up["book_id"])
        return up["book_id"], status
    book_id, status = run(setup())
    assert status["status"] == "review_required", "构造失效：重影书未落草稿"
    detail = run(bp.get_review(book_id))
    assert any(m["rule"] == "R11" for row in detail["chapters"] for m in row["marks"]), \
        "构造失效：R11 未标到重影章"
    return env, book_id


class TestMergeSemantics:
    def test_pair_merge_content_title_anchor(self, draft):
        """重影对合并：组长保留 id、正文按章序拼接、标题取正文最长者、锚点 min-max"""
        env, book_id = draft
        out = run(bp.commit_review(book_id, CommitBody(
            merges=[["m-1", "m-2"], ["m-4", "m-5"]], force=True)))
        assert out["status"] == "committed"
        assert out["total_chapters"] == 3

        chapters = bp.analysis_results[book_id].chapters
        assert [c.chapter_id for c in chapters] == ["m-1", "m-3", "m-4"]
        m1 = chapters[0]
        assert m1.content == FRAG1 + "\n\n" + MAIN1
        assert m1.word_count == len(FRAG1 + "\n\n" + MAIN1)
        assert m1.title == "第一章 面罩"          # 正文最长者是 m-2，标题跟它走
        assert m1.start_position == 100           # min(start)
        assert m1.end_position == 3000            # max(end)
        m4 = chapters[2]
        assert m4.content == FRAG3 + "\n\n" + MAIN3
        assert m4.title == "第三章 又一面罩"
        # 向量/索引一致（合并章正常入库不产孤章）
        assert bp.book_processor.collection.count() > 0
        rec = bp.book_processor.reconcile_book(book_id, chapters)
        assert rec == {"missing": [], "extra": []}

    def test_member_order_in_group_irrelevant(self, draft):
        """组内传序颠倒不影响：组长仍按草稿章序取最小索引者，拼接仍按章序"""
        env, book_id = draft
        run(bp.commit_review(book_id, CommitBody(
            merges=[["m-2", "m-1"]], force=True)))
        chapters = bp.analysis_results[book_id].chapters
        assert [c.chapter_id for c in chapters] == ["m-1", "m-3", "m-4", "m-5"]
        assert chapters[0].content == FRAG1 + "\n\n" + MAIN1

    def test_three_way_chain_merge(self, draft):
        """三章连并：正文两段 \n\n 三个片段、其余章不动"""
        env, book_id = draft
        out = run(bp.commit_review(book_id, CommitBody(
            merges=[["m-1", "m-2", "m-3"]], force=True)))
        assert out["total_chapters"] == 3  # 5 - 3 + 1
        chapters = bp.analysis_results[book_id].chapters
        assert chapters[0].content == FRAG1 + "\n\n" + MAIN1 + "\n\n" + CH2
        assert chapters[0].end_position == 5000
        assert [c.chapter_id for c in chapters[1:]] == ["m-4", "m-5"]

    def test_trivial_groups_ignored(self, draft):
        """单员组 / 去重后不足 2 的组：忽略不报错，章数不变"""
        env, book_id = draft
        out = run(bp.commit_review(book_id, CommitBody(
            merges=[["m-3"], ["m-1", "m-1"], []], force=True)))
        assert out["total_chapters"] == 5

    def test_merge_then_rename_leader_wins(self, draft):
        """rename 最后压顶：组长改名覆盖「最长者标题」规则"""
        env, book_id = draft
        run(bp.commit_review(book_id, CommitBody(
            merges=[["m-1", "m-2"]], renames={"m-1": "人工定名"}, force=True)))
        chapters = bp.analysis_results[book_id].chapters
        assert chapters[0].title == "人工定名"
        assert chapters[0].content == FRAG1 + "\n\n" + MAIN1


class TestMergeValidation:
    def test_duplicate_across_groups_422(self, draft):
        env, book_id = draft
        with pytest.raises(HTTPException) as ei:
            run(bp.commit_review(book_id, CommitBody(
                merges=[["m-1", "m-2"], ["m-2", "m-4"]], force=True)))
        assert ei.value.status_code == 422
        assert "多个合并组" in str(ei.value.detail)

    def test_unknown_id_422(self, draft):
        env, book_id = draft
        with pytest.raises(HTTPException) as ei:
            run(bp.commit_review(book_id, CommitBody(
                merges=[["m-1", "不存在的章"]], force=True)))
        assert ei.value.status_code == 422
        assert "不存在" in str(ei.value.detail)

    def test_merge_and_delete_conflict_422(self, draft):
        env, book_id = draft
        with pytest.raises(HTTPException) as ei:
            run(bp.commit_review(book_id, CommitBody(
                merges=[["m-1", "m-2"]], delete_chapter_ids=["m-2"], force=True)))
        assert ei.value.status_code == 422
        assert "既合并又删除" in str(ei.value.detail)

    def test_failed_merge_leaves_draft_intact(self, draft):
        """422 拒绝后草稿仍在，可修正参数重交（不吞草稿）"""
        env, book_id = draft
        with pytest.raises(HTTPException):
            run(bp.commit_review(book_id, CommitBody(merges=[["m-1", "xyz"]], force=True)))
        assert draft_store.load_draft(book_id) is not None
        out = run(bp.commit_review(book_id, CommitBody(
            merges=[["m-1", "m-2"]], force=True)))
        assert out["total_chapters"] == 4
