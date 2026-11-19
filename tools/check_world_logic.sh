#!/bin/sh
# 世界层逻辑测试：把 Model 层和每条 ios/Tests/*.swift 单独编出来跑，不需要 Xcode 工程。
# 用法（仓库根目录）：sh tools/check_world_logic.sh
set -e
cd "$(dirname "$0")/.."

d=$(mktemp -d)
for t in ios/Tests/*.swift; do
  name=$(basename "$t" .swift)
  swiftc ios/Maomao/Model/WorldScene.swift ios/Maomao/Model/WorldInteraction.swift \
    ios/Maomao/Model/WorldCamera.swift ios/Maomao/Model/WorldMood.swift \
    ios/Maomao/Model/WorldDepth.swift ios/Maomao/Model/Personality.swift ios/Maomao/Model/YardIntent.swift \
    "$t" -o "$d/$name"
  "$d/$name" assets/scenes/courtyard-v4/scene.json
  echo "  ok  $name"
done

for t in ios/BridgeTests/Yard*Tests.swift; do
  name=$(basename "$t" .swift)
  swiftc ios/Maomao/Features/Yard3D/YardProbeSupport.swift "$t" -o "$d/$name"
  "$d/$name"
  echo "  ok  $name"
done
