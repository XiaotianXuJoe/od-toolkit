# Agent 维护说明

## 项目

- 名称：OD 题解工具站
- 技术栈：原生 HTML/JavaScript + Python 标准库
- 生产端口：外部 HTTPS :4000；后端 :4001
- 服务器目录：/home/ubuntu/od-toolkit
- 运行方式：PM2：od-toolkit；nginx HTTPS 反代
- 检查／构建：无需构建；python3 -m py_compile server.py

## 维护约束

保持静态路径和上游代理白名单；不得提交真实 API Key。

- GitHub 是源码权威；生产服务器只保留运行环境、密钥和业务数据。
- 修改应在新分支完成，检查后合并到 `main`，再按提交或标签部署。
- 不得把真实配置、密码、API Key、Cookie、用户数据、数据库、上传文件或日志提交到本公开仓库。
- 不得为了调试而放开静态文件、代理或管理接口的访问控制。
- 不要直接在服务器生产目录手工改代码后不回写仓库。

## 不得进入仓库的运行内容

data/、UPSTREAM_API_KEY、日志和 pid。

详细生产边界见 `docs/PRODUCTION.md`。执行部署前同时参考项目原有 README 和交接文档；如文档冲突，先确认现状再操作。
