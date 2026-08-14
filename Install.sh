#!/usr/bin/env bash
# UniBot Extension Studio 一键安装脚本
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> Extension Studio 安装目录: $STUDIO_DIR"

# 检查 bun
if ! command -v bun >/dev/null 2>&1; then
  echo "==> 未检测到 bun，正在安装…"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 检查 opencode
if ! command -v opencode >/dev/null 2>&1; then
  echo "==> 未检测到 opencode，请先安装：npm install -g opencode-ai 或 brew install opencode"
  echo "    https://opencode.ai/docs/install/"
  exit 1
fi
echo "==> opencode: $(opencode --version 2>/dev/null || echo '已安装')"

# 安装后端依赖
echo "==> 安装后端依赖…"
cd "$STUDIO_DIR/server"
bun install

# 安装前端依赖
echo "==> 安装前端依赖…"
cd "$STUDIO_DIR/web"
bun install

echo ""
echo "==> 安装完成！"
echo ""
echo "启动后端（端口 9876）："
echo "  cd $STUDIO_DIR/server && bun src/index.ts"
echo ""
echo "启动前端（端口 9877，开发模式）："
echo "  cd $STUDIO_DIR/web && bun run dev"
echo ""
echo "浏览器访问：http://localhost:9877"
echo "首次启动自动生成访问口令，保存在 ~/.unibot-studio/config/studio.json"
echo "可通过环境变量 UNIBOT_STUDIO_PASSWORD 覆盖口令"
