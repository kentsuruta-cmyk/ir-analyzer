#!/bin/zsh
# IR分析ツールを常駐起動する。launchd (com.kenjagames.ir-analyzer) から呼ばれる。
# 手動で動かしたいときは、このファイルをそのまま実行してもよい。
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

APP_DIR=/Users/kentsuruta/ir-analyzer
PORT=3000

cd "$APP_DIR" || exit 1

# 3000番に居座っている古い next プロセスがいたら片付けてから起動する。
# （これをしないと Next.js が勝手に3001番へ逃げて、ブックマークが外れる）
for pid in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do
  if ps -p "$pid" -o command= | grep -q "next"; then
    echo "[start-ir] 古いプロセス $pid を停止します"
    kill "$pid" 2>/dev/null
    sleep 2
  fi
done

echo "[start-ir] $(date '+%Y-%m-%d %H:%M:%S') ポート $PORT で起動します"
exec "$APP_DIR/node_modules/.bin/next" dev -p $PORT
