"""资产区（v2.4）：asset_store 存取/筛选/级联/导出 + assets 路由校验"""

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_backend = Path(__file__).parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from app.services import asset_store
from app.routers import assets as assets_router

pytest_plugins = ('pytest_asyncio',)


@pytest.fixture
def store_env(tmp_path, monkeypatch):
    fake = type("S", (), {"data_dir": str(tmp_path)})()
    monkeypatch.setattr(asset_store, "settings", fake)
    return tmp_path


class TestAssetStore:
    def test_add_fields_and_validation(self, store_env):
        a = asset_store.add_asset("b1", "tool", "<h1>报告</h1>", title="总结 · 第三章",
                                  tool_id="summarize", tool_name="总结", output_type="html")
        assert a["type"] == "tool" and a["output_type"] == "html"
        assert a["title"] == "总结 · 第三章" and a["created_at"]
        # title 缺省回落：tool_name > "收藏"
        b = asset_store.add_asset("b1", "note", "正文", tool_name="十问")
        assert b["title"] == "十问" and b["output_type"] == "text"
        c = asset_store.add_asset("b1", "note", "正文")
        assert c["title"] == "收藏"
        with pytest.raises(ValueError):
            asset_store.add_asset("b1", "bogus", "x")     # 未知类型
        with pytest.raises(ValueError):
            asset_store.add_asset("b1", "note", "   ")    # 空内容
        with pytest.raises(ValueError):
            asset_store.add_asset("", "note", "x")        # 无归属书
        # 非法 output_type 静默降级 text（不拦收藏主流程）
        d = asset_store.add_asset("b1", "tool", "x", output_type="weird")
        assert d["output_type"] == "text"

    def test_list_filters(self, store_env):
        asset_store.add_asset("b1", "note", "关于观察的摘录", title="观察")
        asset_store.add_asset("b1", "tool", "全书总结正文", tool_name="总结")
        asset_store.add_asset("b2", "report", "苏格拉底报告", title="收束报告")
        assert len(asset_store.list_assets("b1")) == 2
        assert len(asset_store.list_assets()) == 3
        assert [a["type"] for a in asset_store.list_assets(type="report")] == ["report"]
        hit = asset_store.list_assets("b1", q="观察")            # title 命中
        assert len(hit) == 1 and hit[0]["title"] == "观察"
        hit2 = asset_store.list_assets(q="全书总")               # content 命中、跨书
        assert len(hit2) == 1 and hit2[0]["tool_name"] == "总结"
        assert asset_store.list_assets(q="NOSUCH") == []

    def test_delete_and_cascade(self, store_env):
        a = asset_store.add_asset("b1", "note", "x")
        assert asset_store.delete_asset(a["asset_id"]) is True
        assert asset_store.delete_asset(a["asset_id"]) is False
        asset_store.add_asset("b1", "note", "1")
        asset_store.add_asset("b1", "report", "2")
        asset_store.add_asset("b2", "note", "3")
        assert asset_store.delete_assets_for_book("b1") == 2
        assert len(asset_store.list_assets()) == 1

    def test_export_markdown(self, store_env):
        a1 = asset_store.add_asset("b1", "note", "第一条内容", source="问答收藏")
        a2 = asset_store.add_asset("b1", "tool", "第二条内容", tool_name="总结")
        md = asset_store.export_markdown("b1", title_of=lambda bid: "测试书")
        assert "《测试书》资产区导出" in md
        assert "2 条" in md
        assert "文字" in md and "AI 产出" in md          # 类型标签
        assert "第一条内容" in md and "第二条内容" in md
        assert "问答收藏" in md
        # ids 子集 + 顺序
        md2 = asset_store.export_markdown(ids=[a2["asset_id"], a1["asset_id"]])
        assert "第一条内容" in md2
        assert md2.index("第二条内容") < md2.index("第一条内容")
        assert asset_store.export_markdown("no-such-book") == ""


class TestAssetsRouter:
    def test_post_get_delete(self, store_env):
        req = assets_router.AssetRequest(book_id="b1", type="note",
                                         content="问答内容", title="好问题")
        r = asyncio.run(assets_router.add_asset(req))
        aid = r["asset"]["asset_id"]
        lst = asyncio.run(assets_router.list_assets(book_id="b1", type=None, q=None))
        assert lst["total"] == 1 and lst["assets"][0]["title"] == "好问题"
        assert asyncio.run(assets_router.delete_asset(aid)) == {"ok": True}
        with pytest.raises(HTTPException) as e:
            asyncio.run(assets_router.delete_asset(aid))
        assert e.value.status_code == 404

    def test_post_bad_type_400(self, store_env):
        req = assets_router.AssetRequest(book_id="b1", type="bogus", content="x")
        with pytest.raises(HTTPException) as e:
            asyncio.run(assets_router.add_asset(req))
        assert e.value.status_code == 400

    def test_export_endpoint(self, store_env):
        with pytest.raises(HTTPException) as e:
            asyncio.run(assets_router.export_assets(book_id="b1", ids=None))
        assert e.value.status_code == 404
        asset_store.add_asset("b1", "note", "可导出内容")
        resp = asyncio.run(assets_router.export_assets(book_id="b1", ids=None))
        assert "可导出内容".encode() in resp.body
        assert "filename*=UTF-8''" in resp.headers["content-disposition"]
        # ids 逗号分隔过滤
        ids = "not-exist-id"
        resp2 = None
        with pytest.raises(HTTPException):
            resp2 = asyncio.run(assets_router.export_assets(book_id=None, ids=ids))
        assert resp2 is None   # 全不存在 → 空导出 404
