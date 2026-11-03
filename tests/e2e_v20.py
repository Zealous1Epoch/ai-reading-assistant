# -*- coding: utf-8 -*-
"""v2.0 E2E 冒烟：前端产物服务 + 工具产出落盘端点 + 书架语义搜索 + 对话回归
纯 API 层，不发真实 LLM 请求的项优先；chat 一轮走真实流（DeepSeek），验证持久化链路。
运行：PYTHONPATH=backend venv/bin/python tests/e2e_v20.py
"""
import json
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8000"
PASS, FAIL = 0, 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name} {extra}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {extra}")


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return r.status, r.read().decode("utf-8")


def post(path, payload=None, raw_body=None, stream=False):
    data = raw_body if raw_body is not None else json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path, data=data, method="POST",
        headers={"Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=600)
    if stream:
        return r.status, r
    return r.status, r.read().decode("utf-8")


def delete(path):
    req = urllib.request.Request(BASE + path, method="DELETE")
    r = urllib.request.urlopen(req, timeout=60)
    return r.status, r.read().decode("utf-8")


print("== 1. 首页产物 ==")
st, html = get("/")
check("首页 200", st == 200)
check("引用 dist 新 bundle", "/assets/index-" in html)
# 书架标记：新构建的 JS 里应带 hash 路由与书架字面量
import glob as _g
import os
dist_js = _g.glob(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist", "assets", "index-*.js"))
js_src = open(dist_js[0]).read() if dist_js else ""
check("bundle 含 hash 路由", "#/book/" in js_src)
check("bundle 含工具落盘调用", "/messages" in js_src)
check("bundle 不含旧面板名", "MiddlePanel" not in js_src and "RightPanel" not in js_src)

print("== 2. 书架全局语义搜索 ==")
st, body = get("/search/semantic?query=" + urllib.parse.quote("怎样倾听他人的需要") + "&n_results=5")
results = json.loads(body)
check("semantic 200", st == 200)
check("semantic 有命中", isinstance(results, list) and len(results) > 0, f"{len(results)} 条")
if results:
    r0 = results[0]
    check("结果含跳转所需字段", all(k in r0 for k in ("book_id", "chapter_id", "book_title", "title", "content_snippet")))
    check("相关度为相似度刻度(0~1)", 0.0 <= r0["relevance_score"] <= 1.0, str(r0["relevance_score"]))

print("== 3. 工具产出落盘（产出即消息） ==")
st, body = post("/sessions", {"scope": "book", "book_id": "e2e-v20-none"})
sid = json.loads(body)["session_id"]
try:
    st, body = post(f"/sessions/{sid}/messages", {
        "role": "assistant", "content": "# E2E 导图\n\n## 分支A\n- 要点",
        "kind": "tool", "tool_id": "mindmap", "tool_name": "思维导图",
        "output_type": "mindmap", "scope": "整本书",
    })
    check("落盘 200", st == 200)
    check("返回 message_count", json.loads(body).get("message_count") == 1)

    st, body = post(f"/sessions/{sid}/messages", {
        "role": "assistant", "content": "<html><body>note</body></html>",
        "kind": "tool", "tool_id": "knowledge-graph", "tool_name": "精读笔记",
        "output_type": "html", "filename": "e2e.html", "scope": "第一章",
    })
    check("html 产出落盘 200", st == 200)

    st, body = get(f"/sessions/{sid}")
    s = json.loads(body)
    msgs = s["messages"]
    check("两条消息顺序正确", [m.get("tool_id") for m in msgs] == ["mindmap", "knowledge-graph"])
    check("meta 字段完整", msgs[0]["kind"] == "tool" and msgs[0]["output_type"] == "mindmap"
          and msgs[1]["filename"] == "e2e.html" and msgs[1]["scope"] == "第一章")
    check("工具开场会话标题兜底", s["title"] == "思维导图 · 工具产出", s["title"])
    check("无脏 None 字段", "filename" not in msgs[0] and "sources" not in msgs[0])

    # 校验拒绝路径
    for label, bad, code in [
        ("role", {"role": "system", "content": "x"}, 400),
        ("kind", {"role": "assistant", "content": "x", "kind": "weird"}, 400),
        ("空content", {"role": "assistant", "content": "   "}, 400),
    ]:
        try:
            post(f"/sessions/{sid}/messages", bad)
            check(f"拒绝 {label}", False)
        except urllib.error.HTTPError as e:
            check(f"拒绝 {label}", e.code == code, str(e.code))
    try:
        post("/sessions/no-such/messages", {"content": "x"})
        check("坏会话 404", False)
    except urllib.error.HTTPError as e:
        check("坏会话 404", e.code == 404, str(e.code))
finally:
    st, _ = delete(f"/sessions/{sid}")
    check("清理会话", st == 200)

print("== 4. 对话流回归（真实 LLM 一轮） ==")
books = json.loads(get("/books/list")[1])["books"]
book = next(b for b in books if b["title"] == "游子吟")
ch0 = book["chapters"][0]
st, body = post("/sessions", {"scope": "book", "book_id": book["book_id"]})
sid2 = json.loads(body)["session_id"]
try:
    st, resp = post("/analysis/chat/stream", {
        "message": "这本书大致讲了什么？一句话回答。",
        "chat_history": [], "session_id": sid2,
        "book_id": book["book_id"], "chapter_id": ch0["chapter_id"],
    }, stream=True)
    check("chat/stream 200", st == 200)
    text, sources_seen, buffer = "", False, ""
    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buffer += chunk.decode("utf-8", "ignore")
        lines = buffer.split("\n")
        buffer = lines.pop()
        for line in lines:
            if not line.startswith("data: "):
                continue
            p = line[6:]
            if p == "[DONE]":
                continue
            try:
                f = json.loads(p)
            except Exception:
                continue
            if f.get("content"):
                text += f["content"]
            if f.get("sources"):
                sources_seen = True
    check("流式有内容", len(text) > 5, f"{len(text)} 字")
    st, body = get(f"/sessions/{sid2}")
    s2 = json.loads(body)
    roles = [m["role"] for m in s2["messages"]]
    check("user+assistant 落盘", roles == ["user", "assistant"], str(roles))
    # 工具消息可与问答共存（前端追问路径的数据前提）
    st, _ = post(f"/sessions/{sid2}/messages", {
        "content": "工具摘录测试", "kind": "tool", "tool_id": "summarize",
        "tool_name": "总结", "output_type": "text", "scope": "整本书",
    })
    check("问答会话追加工具消息", st == 200)
    st, body = get(f"/sessions/{sid2}")
    s3 = json.loads(body)
    check("三消息序列", [m["role"] for m in s3["messages"]] == ["user", "assistant", "assistant"]
          and s3["messages"][2]["kind"] == "tool")
    check("标题仍取首问", not s3["title"].startswith("工具"), s3["title"])
finally:
    delete(f"/sessions/{sid2}")

print("== 5. 专家接口回归 ==")
st, body = get("/experts")
exps = json.loads(body)["experts"]
check("experts 3 个", len(exps) == 3, str(len(exps)))

print()
print(f"PASS {PASS}  FAIL {FAIL}")
raise SystemExit(1 if FAIL else 0)
