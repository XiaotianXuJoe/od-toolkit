#!/bin/bash
# 停止后台运行的服务
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/server.pid" ]; then
    kill "$(cat "$DIR/server.pid")" 2>/dev/null && echo "已停止" || echo "进程不存在"
    rm -f "$DIR/server.pid"
else
    pkill -f "od-toolkit/server.py" && echo "已停止" || echo "未找到运行中的服务"
fi
