"""Draws the performance charts from docs/perf/benchmark.json and docs/perf/evaluation.json.

    python scripts/charts.py          (requires matplotlib)
Output: docs/perf/*.png
"""
import json
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = pathlib.Path(__file__).resolve().parent.parent
PERF = ROOT / "docs" / "perf"
bench = json.loads((PERF / "benchmark.json").read_text(encoding="utf-8"))
evaluation = json.loads((PERF / "evaluation.json").read_text(encoding="utf-8"))
runs = bench["runs"]
users = [r["counts"]["users"] for r in runs]
inter = [r["counts"]["interactions"] for r in runs]
xlabels = [f"{u:,}\n({i/1000:.0f}k events)" for u, i in zip(users, inter)]

INK, MUTED, GRID = "#202c24", "#6b736b", "#e3e3dc"
C = {"naive": "#c0504d", "user": "#e9a36d", "item": "#263d32", "l2": "#5b8c6e", "l1": "#9cc5a1", "scan": "#c0504d", "plain": "#e9a36d", "cover": "#263d32"}
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": "#b9bdb5", "axes.labelcolor": INK,
    "xtick.color": MUTED, "ytick.color": MUTED, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True, "legend.frameon": False,
})


def save(fig, name):
    fig.tight_layout()
    fig.savefig(PERF / name, dpi=200)
    plt.close(fig)
    print("saved", name)


def lat(run, key, stat="p50"):
    return run["latency"][key][stat]


# 1. request latency vs data size (log scale)
fig, ax = plt.subplots(figsize=(8, 4.6))
series = [
    ("naive item-CF (no pre-computation)", "Naive item-CF: similarities computed per request", C["naive"], "o"),
    ("user-CF, on request", "User-based CF, on request", C["user"], "s"),
    ("item-CF, pre-computed, no cache", "Item-based CF, pre-computed model, no cache", C["item"], "D"),
    ("item-CF + database cache (L2)", "+ MongoDB cache (L2)", C["l2"], "^"),
    ("item-CF + memory cache (L1)", "+ in-memory cache (L1)", C["l1"], "v"),
]
for key, label, color, marker in series:
    ys = [lat(r, key) for r in runs]
    ax.plot(users, ys, marker=marker, color=color, label=label, linewidth=2)
    ax.annotate(f"{ys[-1]:g} ms", (users[-1], ys[-1]), textcoords="offset points", xytext=(8, -3), fontsize=8, color=color)
ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xticks(users)
ax.set_xticklabels(xlabels, fontsize=8)
ax.set_xlim(users[0] * 0.8, users[-1] * 2.2)
ax.set_xlabel("Synthetic users in the database")
ax.set_ylabel("Median latency per request, ms (log scale)")
ax.set_title("Recommendation latency as the database grows", loc="left", fontsize=12, color=INK)
ax.legend(fontsize=8, loc="upper left")
save(fig, "latency-vs-size.png")

# 2. model build time vs size
fig, ax = plt.subplots(figsize=(7, 3.8))
load = [r["model"]["loadMs"] / 1000 for r in runs]
comp = [r["model"]["computeMs"] / 1000 for r in runs]
rest = [max(0, r["model"]["totalMs"] / 1000 - l - c) for r, l, c in zip(runs, load, comp)]
pos = range(len(runs))
ax.bar(pos, load, color=C["l2"], label="read interactions from MongoDB")
ax.bar(pos, comp, bottom=load, color=C["item"], label="compute similarities (Node.js)")
ax.bar(pos, rest, bottom=[a + b for a, b in zip(load, comp)], color=C["plain"], label="write item_similarities")
for p, r in zip(pos, runs):
    ax.text(p, r["model"]["totalMs"] / 1000 + 0.1, f"{r['model']['totalMs']/1000:.2f} s", ha="center", fontsize=9, color=INK)
ax.set_xticks(list(pos))
ax.set_xticklabels(xlabels, fontsize=8)
ax.set_ylabel("Seconds")
ax.set_title("Offline build time of the item–item model", loc="left", fontsize=12, color=INK)
ax.legend(fontsize=8)
save(fig, "model-build.png")

# 3. preference query: access paths (largest data set)
big = runs[-1]
paths = big["accessPaths"]
labels = ["Collection scan", "Ordinary index\n(user_history + FETCH)", "Covering index\n(user_item_prefs)"]
keys = ["collection scan", "ordinary index (user_history)", "covering index (user_item_prefs)"]
fig, (a1, a2) = plt.subplots(1, 2, figsize=(9, 3.6))
docs = [paths[k]["docsExamined"] for k in keys]
ms = [paths[k]["latency"]["p50"] for k in keys]
cols = [C["scan"], C["plain"], C["cover"]]
a1.barh(labels, docs, color=cols)
a1.set_xscale("symlog")
a1.set_title("Documents examined", loc="left", fontsize=11, color=INK)
for i, v in enumerate(docs):
    a1.text(max(v, 1) * 1.1 if v else 1.2, i, f"{v:,}", va="center", fontsize=9)
a2.barh(labels, ms, color=cols)
a2.set_xscale("log")
a2.set_title("Median latency, ms (log)", loc="left", fontsize=11, color=INK)
a2.set_yticklabels([])
for i, v in enumerate(ms):
    a2.text(v * 1.1, i, f"{v:g} ms", va="center", fontsize=9)
fig.suptitle(f"User preference query on {big['counts']['interactions']:,} interactions", x=0.02, ha="left", fontsize=12, color=INK)
save(fig, "access-paths.png")

# 4. user-CF neighbour queries with / without covering indexes
fig, ax = plt.subplots(figsize=(7, 3.6))
w = 0.38
with_ix = [lat(r, "user-CF queries, covering indexes") for r in runs]
no_ix = [lat(r, "user-CF queries, no covering indexes") for r in runs]
ax.bar([p - w / 2 for p in pos], no_ix, w, color=C["plain"], label="without covering indexes")
ax.bar([p + w / 2 for p in pos], with_ix, w, color=C["cover"], label="with covering indexes")
for p, a, b in zip(pos, no_ix, with_ix):
    ax.text(p - w / 2, a + 10, f"{a:.0f}", ha="center", fontsize=8)
    ax.text(p + w / 2, b + 10, f"{b:.0f}", ha="center", fontsize=8)
ax.set_xticks(list(pos))
ax.set_xticklabels(xlabels, fontsize=8)
ax.set_ylabel("Median latency, ms")
ax.set_title("User-based CF: neighbour queries", loc="left", fontsize=12, color=INK)
ax.legend(fontsize=8)
save(fig, "user-cf-indexes.png")

# 5. offline accuracy
res = evaluation["results"]
k = evaluation["k"]
metrics = [f"precision@{k}", f"recall@{k}", f"hitRate@{k}", f"ndcg@{k}"]
fig, ax = plt.subplots(figsize=(8, 3.8))
w = 0.2
colors = [C["item"], C["user"], "#9aa39a", "#d4d6cf"]
for n, (r, col) in enumerate(zip(res, colors)):
    xs = [m + (n - 1.5) * w for m in range(len(metrics))]
    ax.bar(xs, [r[m] for m in metrics], w, color=col, label=r["algorithm"])
    for x, m in zip(xs, metrics):
        ax.text(x, r[m] + 0.01, f"{r[m]:.2f}", ha="center", fontsize=7)
ax.set_xticks(range(len(metrics)))
ax.set_xticklabels([m.replace("@", " @") for m in metrics])
ax.set_ylim(0, 0.9)
ax.set_title(f"Offline accuracy (hold-out, {evaluation['testUsers']} test users)", loc="left", fontsize=12, color=INK)
ax.legend(fontsize=8, ncol=4, loc="upper left")
save(fig, "accuracy.png")
