"""本地中文 embedding：bge-small-zh-v1.5 的 ONNX 版（onnxruntime + tokenizers）。

为什么不用 ChromaDB 默认 embedding：那是英文 MiniLM，中文书籍文本的语义向量
质量差，检索召回全靠运气。bge-small-zh 是中文检索向小模型，CLS pooling +
L2 归一化后配合 cosine 距离使用。

模型文件不入库，首次使用前下载：
    python scripts/download_embedding_model.py
"""
from pathlib import Path
from typing import List, Optional

from app.config import get_settings

_settings = get_settings()

_ef_instance = None


class BGESmallZhONNXEmbeddingFunction:
    """实现 chromadb EmbeddingFunction 协议（__call__(input: List[str])）。

    注意：chromadb 对"入库文档"和"查询文本"走同一个 __call__，
    无法区分加 query instruction，因此这里做对称编码（不加指令前缀）。
    """

    MAX_TOKENS = 512
    BATCH_SIZE = 32

    def __init__(self, model_dir: str):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.model_dir = Path(model_dir)
        onnx_path = self.model_dir / "onnx" / "model.onnx"
        tok_path = self.model_dir / "tokenizer.json"
        if not onnx_path.exists() or not tok_path.exists():
            raise RuntimeError(
                f"未找到中文 embedding 模型文件：{self.model_dir}\n"
                "请先运行：python scripts/download_embedding_model.py\n"
                "（或在 .env 设置 EMBEDDING_PROVIDER=chroma_default 退回默认英文模型）"
            )

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            str(onnx_path), sess_options=so, providers=["CPUExecutionProvider"]
        )
        self.tokenizer = Tokenizer.from_file(str(tok_path))
        self.tokenizer.enable_truncation(max_length=self.MAX_TOKENS)
        self.tokenizer.enable_padding()  # 动态 pad 到批内最长

    def _encode(self, texts: List[str]) -> List[List[float]]:
        import numpy as np

        encodings = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in encodings], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
        type_ids = np.zeros_like(ids)  # 单句编码，token_type 全零

        outputs = self.session.run(
            None,
            {"input_ids": ids, "attention_mask": mask, "token_type_ids": type_ids},
        )
        last_hidden = outputs[0]                      # (B, T, H)
        cls = last_hidden[:, 0, :]                    # bge 用 CLS pooling
        norms = np.linalg.norm(cls, axis=1, keepdims=True)
        return (cls / np.maximum(norms, 1e-12)).tolist()

    def __call__(self, input: List[str]) -> List[List[float]]:
        if isinstance(input, str):
            input = [input]
        vectors: List[List[float]] = []
        for i in range(0, len(input), self.BATCH_SIZE):
            vectors.extend(self._encode(input[i : i + self.BATCH_SIZE]))
        return vectors

    # chromadb 1.x 协议：入库走 __call__/embed_documents，查询走 embed_query。
    # bge 这里做对称编码（不加指令前缀），两条路径同实现。
    def embed_documents(self, input: List[str]) -> List[List[float]]:
        return self(input)

    def embed_query(self, input: List[str]) -> List[List[float]]:
        return self(input)

    def name(self) -> str:
        return "bge-small-zh-v1.5-onnx"


def get_embedding_function() -> Optional[object]:
    """按配置返回 embedding function；返回 None 表示用 chromadb 内置默认。"""
    global _ef_instance
    provider = (_settings.embedding_provider or "bge").lower()
    if provider == "chroma_default":
        return None
    if _ef_instance is None:
        _ef_instance = BGESmallZhONNXEmbeddingFunction(_settings.embedding_model_dir)
    return _ef_instance
