#!/bin/bash
# 华为OD题解工作流 —— 一键启动脚本（端口 4000，含风格数据后端）
# 用法: bash start.sh        前台运行（Ctrl+C 停止）
#       bash start.sh -d     后台运行（日志在 server.log，停止用 bash stop.sh）
#
# 环境变量：
#   PORT        端口，默认 4000
#   SYNC_TOKEN  同步密钥，设置后浏览器端需在设置面板填写同一密钥才能同步风格数据
#               生产环境务必设置，例如: SYNC_TOKEN=你的密钥 bash start.sh -d

PORT="${PORT:-4000}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" = "-d" ]; then
    SYNC_TOKEN="${SYNC_TOKEN}" PORT="$PORT" nohup python3 "$DIR/server.py" > "$DIR/server.log" 2>&1 &
    echo $! > "$DIR/server.pid"
    echo "已在后台启动: http://0.0.0.0:$PORT  (PID $(cat "$DIR/server.pid"))"
    [ -z "$SYNC_TOKEN" ] && echo "警告: 未设置 SYNC_TOKEN，/api/style 接口公开可访问"
else
    echo "启动中: http://0.0.0.0:$PORT  (Ctrl+C 停止)"
    [ -z "$SYNC_TOKEN" ] && echo "警告: 未设置 SYNC_TOKEN，/api/style 接口公开可访问"
    exec env SYNC_TOKEN="${SYNC_TOKEN}" PORT="$PORT" python3 "$DIR/server.py"
fi
