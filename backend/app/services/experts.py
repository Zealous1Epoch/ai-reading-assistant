"""专家模式注册表 —— 文件化专家包加载器（规范参照 WorkBuddy 专家包 v2.0 精简版）

每个专家 = backend/app/experts/<expert_id>.json 一个包文件，新增专家即放新文件，
不改代码（每次读取扫描目录，热更新）。

包字段（展示与方法论分离）：
- 展示：name（花名）/ profession（职业）/ method（方法论一句话）/
        tagline / displayDescription（能力介绍）/ tags（擅长领域 ×3）/
        quickPrompts（试试这样问 ×3）
- 方法论三要素（缺一即提示词马甲，validate 拒绝加载）：
        system（回合规则）/ opening（起手式）/ report（收束报告指令）

所有追问基于注入的参考内容（RAG 检索）；引用出处统一「《书名》·章节名」。
"""
import glob
import json
import os
from typing import Optional

from app.config import FROZEN, bundle_root
from app.routers.book_processor import analysis_results as books_index

# v3.9 打包：冻结态专家包（.json）随 bundle 分发到 experts/；开发态维持 app/experts 原位
_PACK_DIR = (
    os.path.join(bundle_root(), "experts") if FROZEN
    else os.path.join(os.path.dirname(os.path.dirname(__file__)), "experts")
)
_REQUIRED = ("expert_id", "name", "method", "system", "opening", "report")


def book_title_of(book_id: Optional[str]) -> str:
    if not book_id:
        return "这本书"
    entry = books_index.get(book_id)
    return (getattr(entry, "title", "") or "").strip() or "这本书"


def _load_packs() -> dict:
    packs = {}
    for path in sorted(glob.glob(os.path.join(_PACK_DIR, "*.json"))):
        try:
            with open(path, "r", encoding="utf-8") as f:
                pack = json.load(f)
        except Exception as e:
            print(f"专家包加载失败 {path}: {e}")
            continue
        missing = [k for k in _REQUIRED if not pack.get(k)]
        if missing:
            print(f"专家包缺字段 {pack.get('expert_id', path)}: {missing}")
            continue
        packs[pack["expert_id"]] = pack
    return packs


def get_expert(expert_id: str) -> Optional[dict]:
    return _load_packs().get(expert_id)


def list_experts() -> list:
    """仅展示字段（提示词不外发给前端）"""
    out = []
    for eid, p in _load_packs().items():
        out.append({
            "expert_id": eid,
            "name": p.get("name", eid),
            "profession": p.get("profession", ""),
            "method": p.get("method", ""),
            "tagline": p.get("tagline", ""),
            "displayDescription": p.get("displayDescription", ""),
            "tags": p.get("tags", []),
            "quickPrompts": p.get("quickPrompts", []),
        })
    return out


def _fill(template: str, book_id: Optional[str]) -> str:
    return template.replace("{book_ctx}", f"《{book_title_of(book_id)}》")


def build_system(expert_id: str, book_id: Optional[str]) -> str:
    return _fill(get_expert(expert_id)["system"], book_id)


def build_opening_system(expert_id: str, book_id: Optional[str]) -> str:
    return _fill(get_expert(expert_id)["opening"], book_id)


def build_report_system(expert_id: str, book_id: Optional[str]) -> str:
    return _fill(get_expert(expert_id)["report"], book_id)
