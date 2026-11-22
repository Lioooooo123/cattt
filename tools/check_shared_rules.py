#!/usr/bin/env python3
"""跨端一致性检查：同一套院子规则在 iOS、后端、网页各写了一份，这里比对它们没有漂移。

跑法（仓库根目录）：python3 tools/check_shared_rules.py
挂在本机 pre-commit，以及 .github/workflows/checks.yml。

检查五件事：
1. 行为参数表：4 种气质 × 81 组特征 × 熟/未熟，逐字段比较 iOS、旧后端、新宿主的实际结果。
2. 氛围关键帧：iOS Atmosphere.keyframes 与网页 KEYFRAMES 的（小时，时段）表。
3. 地点顺序：scene.json 的 destinations 与后端 destinationIds、iOS Location.all 的名称顺序。
4. 场景版本：scene.json 的 version 与后端 world/protocol.ts 的 sceneVersion 字面量。
5. 生成物：web/src/yard/layout.generated.ts 与 assets/yard-3d/make_paths.py 重跑的结果是否一致
   （改了 scene.json 或 layout.py 忘了重生成，这里会拦下）。

失败就退出码 1，并打出第一处不一致；规则见 docs/工作约定.md。
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENE = os.path.join(ROOT, 'assets/scenes/courtyard-v4/scene.json')
TOLERANCE = 1e-9


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def fail(title, detail):
    print(f'跨端检查不通过：{title}')
    for line in detail:
        print('  - ' + line)
    print('规则见 docs/工作约定.md；改了其中一端就同步改另一端。')
    sys.exit(1)


def close(a, b):
    return abs(a - b) <= TOLERANCE


# ---------- 1. 行为参数表 ----------

SWIFT_DUMP = '''
import Foundation

let temps: [Temperament] = [.slow, .close, .quiet, .curious]
var rows: [[String: Any]] = []
for t in temps {
    for e in 0...2 { for i in 0...2 { for d in 0...2 { for c in 0...2 {
        for days in [0, 3] {
            let traits: [Trait: Int] = [.energy: e, .initiative: i, .directness: d, .closeness: c]
            let p = BehaviorParams.compile(temperament: t, traits: traits, daysSinceAdoption: days)
            rows.append([
                "temperament": t.rawValue,
                "traits": [e, i, d, c],
                "days": days,
                "params": [
                    "idleScale": p.idleScale, "homeIdleScale": p.homeIdleScale,
                    "sleepWeight": p.sleepWeight, "lookWeight": p.lookWeight,
                    "tiltShare": p.tiltShare, "groomWeight": p.groomWeight,
                    "placeWeights": p.placeWeights, "comesToDoor": p.comesToDoor,
                    "moodScale": p.moodScale,
                    "drinkDelay": [p.drinkDelay.lowerBound, p.drinkDelay.upperBound],
                    "diarySentences": p.diarySentences,
                ],
            ])
        }
    }}}}
}
let data = try! JSONSerialization.data(withJSONObject: rows)
FileHandle.standardOutput.write(data)
'''

TS_DUMP = '''
import { compileBehavior } from '%s';

const temps = ['slow', 'close', 'quiet', 'curious'];
const rows = [];
for (const t of temps)
  for (const e of [0, 1, 2]) for (const i of [0, 1, 2])
    for (const d of [0, 1, 2]) for (const c of [0, 1, 2]) for (const days of [0, 3]) {
      const p = compileBehavior(t, { energy: e, initiative: i, directness: d, closeness: c }, days);
      rows.push({ temperament: t, traits: [e, i, d, c], days, params: {
        idleScale: p.idleScale, homeIdleScale: p.homeIdleScale,
        sleepWeight: p.sleepWeight, lookWeight: p.lookWeight,
        tiltShare: p.tiltShare, groomWeight: p.groomWeight,
        placeWeights: p.placeWeights, comesToDoor: p.comesToDoor,
        moodScale: p.moodScale, drinkDelay: p.drinkDelay,
        diarySentences: p.diarySentences } });
    }
console.log(JSON.stringify(rows));
'''


def behavior_rows():
    tmp = tempfile.mkdtemp(prefix='maomao-rules-')
    swift_src = os.path.join(tmp, 'main.swift')  # swiftc 只允许 main.swift 里有顶层代码
    swift_bin = os.path.join(tmp, 'dump')
    with open(swift_src, 'w', encoding='utf-8') as f:
        f.write(SWIFT_DUMP)
    model = os.path.join(ROOT, 'ios/Maomao/Model/Personality.swift')
    try:
        subprocess.run(['swiftc', model, swift_src, '-o', swift_bin], check=True, capture_output=True, text=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        fail('行为参数表 · iOS 侧编译失败', [str(getattr(e, 'stderr', e)).strip()[-400:]])
    ios_rows = json.loads(subprocess.run([swift_bin], check=True, capture_output=True, text=True).stdout)

    ts_src = os.path.join(tmp, 'dump.mjs')
    datasets = []
    for name, path in [('旧后端', 'server/src/runtime/behavior.ts'), ('新宿主', 'host/src/world/behavior.ts')]:
        with open(ts_src, 'w', encoding='utf-8') as f:
            f.write(TS_DUMP % os.path.join(ROOT, path))
        try:
            out = subprocess.run(['node', '--experimental-strip-types', ts_src], check=True, capture_output=True, text=True).stdout
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            fail(f'行为参数表 · {name}运行失败', [str(getattr(e, 'stderr', e)).strip()[-400:]])
        datasets.append((name, json.loads(out)))
    shutil.rmtree(tmp)
    return ios_rows, datasets


def check_behavior():
    ios_rows, datasets = behavior_rows()
    for name, rows in datasets:
        compare_behavior(ios_rows, rows, name)
    return f"{len(ios_rows)} 组行为参数在 iOS、旧后端和新宿主完全一致"


def compare_behavior(ios_rows, server_rows, name):
    if len(ios_rows) != len(server_rows):
        fail('行为参数表 · 行数不同', [f'iOS {len(ios_rows)} 行，{name} {len(server_rows)} 行'])
    for a, b in zip(ios_rows, server_rows):
        where = f"气质 {a['temperament']}、特征 {a['traits']}、领养 {a['days']} 天"
        if a['temperament'] != b['temperament'] or a['traits'] != b['traits'] or a['days'] != b['days']:
            fail('行为参数表 · 行顺序不同', [f'{where} 对不上 {b["temperament"]} {b["traits"]} {b["days"]}'])
        for key, av in a['params'].items():
            bv = b['params'][key]
            if isinstance(av, list):
                same = isinstance(bv, list) and len(av) == len(bv) and all(close(x, y) for x, y in zip(av, bv))
            elif isinstance(av, bool):
                same = av is bv
            else:
                same = close(av, bv)
            if not same:
                fail('行为参数表不一致', [f'{where}：{key} iOS = {av}，{name} = {bv}'])


# ---------- 2. 氛围关键帧 ----------

def check_keyframes():
    ios = read('ios/Maomao/Model/Atmosphere.swift')
    block = re.search(r'static let keyframes.*?= \[(.*?)\]', ios, re.S)
    if not block:
        fail('氛围关键帧 · 找不到 iOS 的 keyframes', ['ios/Maomao/Model/Atmosphere.swift'])
    ios_frames = [(float(h), s) for h, s in re.findall(r'\(([\d.]+),\s*(\w+)\)', block.group(1))]

    web = read('web/src/yard/atmosphere.ts')
    block = re.search(r'const KEYFRAMES[^=]*=\s*\[(.*?)\];', web, re.S)
    if not block:
        fail('氛围关键帧 · 找不到网页的 KEYFRAMES', ['web/src/yard/atmosphere.ts'])
    web_frames = [(float(h), s) for h, s in re.findall(r'\[([\d.]+),\s*\'(\w+)\'\]', block.group(1))]

    if len(ios_frames) != len(web_frames) or any(
        not close(a[0], b[0]) or a[1] != b[1] for a, b in zip(ios_frames, web_frames)
    ):
        fail('氛围关键帧不一致', [f'iOS  {ios_frames}', f'网页 {web_frames}'])
    return f"{len(ios_frames)} 个氛围关键帧在 iOS 与网页一致"


WORLD_PROTOCOLS = ('server/src/world/protocol.ts', 'host/src/world/protocol.ts')


# ---------- 3. 地点顺序 ----------

def check_destinations():
    scene = json.load(open(SCENE, encoding='utf-8'))
    ids = [d['id'] for d in scene['destinations']]
    names = [d['name'] for d in scene['destinations']]

    for path in WORLD_PROTOCOLS:
        protocol = read(path)
        protocol_ids = re.findall(r"""['"]([a-z]+)['"]""", re.search(r'destinationIds = \[(.*?)\]', protocol).group(1))
        if protocol_ids != ids:
            fail('地点表与 scene.json 不一致', [f'scene.json {ids}', f'{path} {protocol_ids}'])

    location = read('ios/Maomao/Model/Location.swift')
    ios_names = re.findall(r'id: \.\w+,\s*name: "([^"]+)"', location)
    if ios_names != names:
        fail('地点表 · iOS Location.all 与 scene.json 顺序或名字不一致（模拟器按数组下标取地点）',
             [f'scene.json {names}', f'Location.all {ios_names}'])
    return f"{len(ids)} 个地点的 id 与名称顺序在 scene.json、旧后端、新宿主、iOS 一致"


# ---------- 4. 场景版本 ----------

def check_scene_version():
    version = json.load(open(SCENE, encoding='utf-8'))['version']
    for path in WORLD_PROTOCOLS:
        literal = int(re.search(r'sceneVersion: z\.literal\((\d+)\)', read(path)).group(1))
        if literal != version:
            fail('场景版本不一致', [f'scene.json version = {version}', f'{path} sceneVersion = {literal}'])
    return f"场景版本 {version} 在 scene.json、旧后端和新宿主一致"


# ---------- 5. 生成物与源同步 ----------

def check_generated_layout():
    rel = 'web/src/yard/layout.generated.ts'
    path = os.path.join(ROOT, rel)
    committed = read(rel)
    result = subprocess.run([sys.executable, os.path.join(ROOT, 'assets/yard-3d/make_paths.py')],
                            capture_output=True, text=True, cwd=ROOT)
    if result.returncode != 0:
        fail('生成物 · make_paths.py 跑失败', [(result.stderr or result.stdout).strip()[-400:]])
    regenerated = read(rel)
    if regenerated != committed:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(committed)          # 检查不改工作区，让人自己重跑并提交
        fail('生成物与源不同步', [f'{rel} 与 make_paths.py 的结果不同',
                                  '改过 scene.json 或 assets/yard-3d/layout.py 后要重跑 python3 assets/yard-3d/make_paths.py 并提交'])
    return f'{rel} 与生成脚本一致'


def main():
    checks = [check_behavior, check_keyframes, check_destinations, check_scene_version, check_generated_layout]
    for check in checks:
        print('  ok  ' + check())
    print('跨端一致性检查通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
