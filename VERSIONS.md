# 智能读书助手 — 版本历史

## v1.4 — 2026-11-03（存档点）
- 前端从 CDN + Babel Standalone 迁移至 Vite + Tailwind 构建（`frontend/src/`，产物 `frontend/dist/` 随仓库提交供 Docker 部署）
- `main.py` 静态服务重写：优先服务 dist 构建产物，新增路径安全校验（防目录穿越）
- 补充 npm 脚本 `dev/build/preview`
- 冒烟测试通过：前端构建、页面服务、书籍列表、全文搜索、语义搜索
- `.gitignore` 加固：`.env` 备份文件、工具目录不入库

## v1.3 — 2026-05-29
- GitHub Pages demo 页面
- Demo 使用说明更新
- Demo 脚本 & 章节切分优化
- 标签：`d90d1a7`

## v1.2 — 2026-05-13
- Railway 部署配置完善（Dockerfile、Procfile、runtime.txt）
- 修复 Railway 兼容性问题
- 前端跨域兼容
- 标签：`2a1a615`

## v1.1 — 2026-05-04
- Railway 部署配置
- 环境变量配置更新
- API 路径相对化
- 标签：`9e28791`

## v1.0 — 2026-05-04
- 初始版本：智能读书助手
- 标签：`109ef19`
