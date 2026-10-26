FROM python:3.12-alpine
WORKDIR /srv
COPY . .
ENV PORT=4000
# 运行时用 -e SYNC_TOKEN=你的密钥 注入同步密钥
EXPOSE 4000
CMD ["python3", "server.py"]
