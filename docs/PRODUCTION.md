# 生产环境边界

- 项目：OD 题解工具站
- 端口：外部 HTTPS :4000；后端 :4001
- 目录：/home/ubuntu/od-toolkit
- 进程：PM2：od-toolkit；nginx HTTPS 反代

## 推荐检查

`无需构建；python3 -m py_compile server.py`

## 不上传、不覆盖

data/、UPSTREAM_API_KEY、日志和 pid。这些内容只应通过独立的生产备份机制保存，不属于 Git 源码。

本仓库公开可见。任何真实凭据都不应写入代码、Issue、Actions 日志或 Git 历史。
