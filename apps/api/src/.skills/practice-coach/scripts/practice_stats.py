#!/usr/bin/env python3
"""练习日志统计：按子技能看趋势，报出客观数字供判断。

用法:
    python scripts/practice_stats.py <日志.csv> [--window N]

CSV 列（首行为表头）:
    date     —— 日期，ISO 格式；按它排序，保证「最近几次」指的是时间上最近的
    subskill —— 子技能名，按它分组
    target   —— 这一轮设定的目标值
    result   —— 这一轮实际成绩，需与 target 同量纲
    minutes  —— 本轮练习分钟数
    product  —— 产物标识（文件路径／链接／一句话）。空 = 没有可评判对象

脚本只负责统计，不判定难度是否合适——那是模型按 SKILL.md Step 3 做的事。
"""

import argparse
import csv
import sys
from collections import defaultdict

USAGE_COLUMNS = "date, subskill, target, result, minutes, product"


def setup_console():
    """Windows 控制台默认 GBK，中文输出前先切成 UTF-8，避免 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def load(path):
    """返回 (rows, bad)；文件打不开时返回 (None, 0) 与「没有记录」区分开。"""
    rows, bad = [], 0
    try:
        f = open(path, newline="", encoding="utf-8-sig")
    except OSError as err:
        print(f"打不开日志文件：{err}", file=sys.stderr)
        return None, 0
    with f:
        for r in csv.DictReader(f):
            try:
                row = {
                    "date": (r.get("date") or "").strip(),
                    "subskill": (r.get("subskill") or "").strip(),
                    "target": float(r.get("target") or 0),
                    "result": float(r.get("result") or 0),
                    "minutes": float(r.get("minutes") or 0),
                    "product": (r.get("product") or "").strip(),
                }
            except (TypeError, ValueError):
                bad += 1
                continue
            if row["subskill"]:
                rows.append(row)
    rows.sort(key=lambda r: r["date"])
    return rows, bad


def analyze(rows, window):
    by_skill = defaultdict(list)
    for r in rows:
        by_skill[r["subskill"]].append(r)

    total_minutes = sum(r["minutes"] for r in rows)
    missing_product = sum(1 for r in rows if not r["product"])
    missing_target = sum(1 for r in rows if r["target"] <= 0)

    print(f"记录 {len(rows)} 条　总练习时长 {total_minutes / 60:.1f} 小时")
    if missing_product:
        print(f"⚠ 没有产物的记录 {missing_product} 条 —— 没有可评判对象，不算练习"
              f"（见 references/feedback.md）")
    if missing_target:
        print(f"⚠ 没有目标值的记录 {missing_target} 条 —— 这些行的达标率恒为 100%，"
              f"难度判定会失真")
    print()

    for skill, items in by_skill.items():
        recent = items[-window:]
        results = [i["result"] for i in recent]
        hit_rate = sum(1 for i in recent if i["result"] >= i["target"]) / len(recent)
        best_recent = max(results)
        best_earlier = max((i["result"] for i in items[:-len(recent)]), default=None)
        new_best = best_earlier is None or best_recent > best_earlier

        print(f"## {skill}")
        print(f"   共 {len(items)} 次，最近 {len(recent)} 次："
              f"最好 {best_recent:g}，最后 {results[-1]:g}，达标率 {hit_rate:.0%}")

        # 只报数，不下难度结论：怎么调难度是模型按 SKILL Step 3 判断的事，
        # 脚本里的阈值没有书中依据，写死会把经验值冒充成结论。
        if len(recent) >= window and not new_best:
            print(f"   → 最近 {len(recent)} 次没有刷新最好成绩，读 references/plateau.md")
        print()

    return 0


def main():
    setup_console()
    p = argparse.ArgumentParser(description="练习日志统计")
    p.add_argument("path")
    p.add_argument("--window", type=int, default=10,
                   help="判定停滞看最近几次，默认 10（经验值，书中未给此数字）")
    args = p.parse_args()
    if args.window < 1:
        p.error("--window 必须 ≥ 1")

    rows, bad = load(args.path)
    if rows is None:
        return 1
    if bad:
        print(f"跳过 {bad} 行无法解析的记录", file=sys.stderr)
    if not rows:
        print(f"还没有练习记录。CSV 需要这些列：{USAGE_COLUMNS}", file=sys.stderr)
        return 1
    return analyze(rows, args.window)


if __name__ == "__main__":
    raise SystemExit(main())
