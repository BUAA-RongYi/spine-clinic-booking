#!/bin/bash
# 一键部署脚本 — 脊柱侧弯门诊预约系统
# 用法: ./deploy.sh
set -e

SERVER="root@43.136.36.235"
KEY="$HOME/.ssh/id_ed25519"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin888}"

echo "==> 1/3 上传代码..."
scp -i "$KEY" server.js "$SERVER:/opt/spine-clinic-booking/"
scp -i "$KEY" public/app.js public/index.html public/style.css public/guide.html "$SERVER:/opt/spine-clinic-booking/public/"

echo "==> 2/3 重启服务..."
ssh -i "$KEY" "$SERVER" "ADMIN_PASSWORD=$ADMIN_PASSWORD pm2 restart spine-clinic --update-env && pm2 save" | grep -E "online|error"

echo "==> 3/3 健康检查..."
sleep 1
STATUS=$(curl -s --connect-timeout 5 http://43.136.36.235:3000/api/health)
if echo "$STATUS" | grep -q '"ok"'; then
  echo "✅ 部署成功: $STATUS"
else
  echo "❌ 健康检查失败: $STATUS"
  exit 1
fi
