#!/usr/bin/env python3
"""v16: a fresh 30x30 square office — two rooms on the right, the server racks on the left.

                         +----------------------+
      WFM racks          | superagent desks     |   top-right room
      LYMAN slot         | lounge: 2 sofa sets  |   (Area 'superagent' = desk strip)
                         +-------door-----------+
                         | workspace: 2 leads   |   bottom-right room
                         | + 2x2 desk units     |   (Area 'ezphot')
                         +----------------------+

The left column has no floor: the server racks (WFM, then a LYMAN slot) stand
on the void at the server-room.json anchor. Seats the persisted agents hold keep their
chair uids (superagent benches, the centre seat — now a sofa — and the ezphot
lead chair).

Reads the live layout only for its pets and colours; everything else is new.

    python3 gen_layout_v16.py <live layout.json> <out layout.json>
"""
import glob
import json
import os
import sys

PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "webview-ui", "public", "assets")
WALL, VOID = 0, 255
ROOM_FLOOR = 7
N = 30

# ---- footprints from the manifests ------------------------------------
fp = {}


def walk(node, cat, bg, surf):
    bg = node.get("backgroundTiles", bg)
    surf = node.get("canPlaceOnSurfaces", surf)
    if node.get("type") == "asset":
        fp[node["id"]] = (node.get("footprintW", 1), node.get("footprintH", 1), cat, bg or 0, surf)
    for m in node.get("members", []):
        walk(m, cat, bg, surf)


for path in glob.glob(PKG + "/furniture/*/*.json"):
    d = json.load(open(path))
    walk(d, d.get("category"), 0, False)

OLD = json.load(open(sys.argv[1]))
OC = OLD["cols"]
old_color = lambda c, r: OLD["tileColors"][r * OC + c]
WALL_COLOR = old_color(0, 9)             # old ezphot room wall
SUPER_COLOR = old_color(27, 4)           # old superagent room floor
WORK_COLOR = old_color(5, 12)            # old ezphot room floor
assert OLD["tiles"][9 * OC] == WALL

T = [VOID] * (N * N)
TC = [WALL_COLOR] * (N * N)
A = [None] * (N * N)
idx = lambda c, r: r * N + c


def fill(c0, c1, r0, r1, tile, color, area=None):
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            T[idx(c, r)], TC[idx(c, r)], A[idx(c, r)] = tile, color, area


# ---- tiles -------------------------------------------------------------
# Left (cols 0-13): void. The server racks stand there at the
# ~/.pixel-agents/server-room.json anchor (serverRoom.ts); the status board
# will come back below them, also without a floor of its own.

# Right: one wall block (cols 14-29, rows 1-29) carved into two rooms that
# share wall row 13. Interior cols 15-28: everything mirrors about col 21.5.
# Furniture below is written for the block one column further left; put()
# shifts it by DX.
RW0, RW1, TOP, MID, BOT = 14, 29, 1, 13, 29
DX = 1
fill(RW0, RW1, TOP, BOT, WALL, WALL_COLOR)
fill(RW0 + 1, RW1 - 1, TOP + 1, MID - 1, ROOM_FLOOR, SUPER_COLOR)   # top room
fill(RW0 + 1, RW1 - 1, MID + 1, BOT - 1, ROOM_FLOOR, WORK_COLOR)    # workspace
DOOR = (20 + DX, 21 + DX)
for c in DOOR:
    T[idx(c, MID)], TC[idx(c, MID)] = ROOM_FLOOR, SUPER_COLOR

# Areas: the superagent desk strip (lounge stays unzoned so its sofas don't
# pull superagents off their desks), the whole workspace.
for r in range(TOP + 1, 7):
    for c in range(RW0 + 1, RW1):
        A[idx(c, r)] = "superagent"
for r in range(MID + 1, BOT):
    for c in range(RW0 + 1, RW1):
        A[idx(c, r)] = "ezphot"

# ---- furniture ---------------------------------------------------------
furniture = []
seq = [0]


def put(type_, col, row, uid=None, **extra):
    if uid is None:
        seq[0] += 1
        uid = f"f-v16-{seq[0]:03d}"
    furniture.append({"uid": uid, "type": type_, "col": col + DX, "row": row, **extra})


def desk_unit(col, row):
    """Table with a PC and a side chair on each side: 5 wide x 4 tall, 2 seats."""
    put("WOODEN_CHAIR_SIDE", col, row)
    put("TABLE_FRONT", col + 1, row)
    put("PC_SIDE", col + 1, row)
    put("PC_SIDE:left", col + 3, row)
    put("WOODEN_CHAIR_SIDE:left", col + 4, row)


def sofa_set(col, row):
    """Sofas round a coffee table: 4 x 4."""
    put("SOFA_FRONT", col + 1, row)
    put("SOFA_SIDE", col, row + 1)
    put("COFFEE_TABLE", col + 1, row + 1)
    put("SOFA_SIDE:left", col + 3, row + 1)
    put("COFFEE", col + 1, row + 2)
    put("SOFA_BACK", col + 1, row + 3)


# Top room — superagent desk strip, centred (rows 2-6)
put("HANGING_PLANT", 14, TOP)
put("DOUBLE_BOOKSHELF", 15, 0)
put("LARGE_PAINTING", 20, 0)
put("DOUBLE_BOOKSHELF", 25, 0)
put("HANGING_PLANT", 27, TOP)
put("DESK_FRONT", 15, 3, uid="f-v13-036")
put("PC_FRONT_OFF", 16, 3, uid="f-v13-037")
put("CUSHIONED_BENCH", 16, 5, uid="f-v13-038", pinned=True)
put("PLANT_2", 19, 2)
put("SOFA_FRONT", 20, 3, uid="f-179276839284", pinned=True)
put("PLANT_2", 22, 2)
put("DESK_FRONT", 24, 3, uid="f-v13-039")
put("PC_FRONT_OFF", 25, 3, uid="f-v13-040")
put("CUSHIONED_BENCH", 25, 5, uid="f-v13-041", pinned=True)

# Top room — lounge (bottom half)
sofa_set(15, 8)
sofa_set(23, 8)
put("PLANT_2", 14, 11)
put("PLANT_2", 27, 11)

# Workspace — two lead desks either side of the door, 2 x 2 desk units below
put("HANGING_PLANT", 14, MID)
put("HANGING_PLANT", 27, MID)
put("SMALL_PAINTING", 17, MID - 1)
put("SMALL_PAINTING_2", 24, MID - 1)
put("DESK_FRONT", 17, 15)
put("CUSHIONED_CHAIR_FRONT", 18, 15, uid="f-179277065902", pinned=True)
put("PC_BACK", 18, 15)
put("DESK_FRONT", 22, 15)
put("CUSHIONED_CHAIR_FRONT", 23, 15, pinned=True)
put("PC_BACK", 23, 15)
for col in (15, 22):
    for row in (18, 22):
        desk_unit(col, row)
put("PLANT_2", 14, 27)
put("PLANT_2", 27, 27)

# ---- validate ----------------------------------------------------------


def info(f):
    return fp[f["type"].split(":")[0]]   # ":left" etc. = mirrored, same footprint


def cells(f):
    w, h, _, bg, _ = info(f)
    return [(f["col"] + dc, f["row"] + dr, dr < bg) for dr in range(h) for dc in range(w)]


uids = [f["uid"] for f in furniture]
assert len(uids) == len(set(uids)), "duplicate uid"
desk_tiles = {(c, r) for f in furniture if info(f)[2] == "desks" for c, r, _ in cells(f)}
for f in furniture:
    kind = info(f)[2]
    cs = cells(f)
    if kind == "wall":
        # bottom row on a wall tile (hanging plants hang one row below it)
        bottom = max(r for _, r, _ in cs)
        rows_on_wall = [r for c, r, _ in cs if 0 <= r < N and T[idx(c, r)] == WALL]
        assert rows_on_wall, (f["uid"], f["type"], "not on a wall")
        continue
    for c, r, _ in cs:
        assert 0 <= c < N and 0 <= r < N, (f["uid"], c, r)
        assert T[idx(c, r)] not in (WALL, VOID), (f["uid"], f["type"], c, r, T[idx(c, r)])
for i, f in enumerate(furniture):
    if info(f)[2] == "wall":
        continue
    surface = info(f)[4]
    for g in furniture[i + 1:]:
        if info(g)[2] == "wall":
            continue
        gsurf = info(g)[4]
        mine = {(c, r) for c, r, bg in cells(f) if not bg}
        theirs = {(c, r) for c, r, bg in cells(g) if not bg}
        for c, r in mine & theirs:
            if (surface or gsurf) and (c, r) in desk_tiles:
                continue
            # a chair on its desk's background row (lead desk) is the old pattern
            raise SystemExit(f"overlap {f['uid']} {f['type']} / {g['uid']} {g['type']} at {(c, r)}")

# every walkable tile of the right block reachable from the door
blocked = {(c, r) for f in furniture if info(f)[2] not in ("wall", "chairs")
           for c, r, bg in cells(f) if not bg}
walk_ok = lambda c, r: T[idx(c, r)] not in (WALL, VOID) and (c, r) not in blocked
seen, stack = {(DOOR[0], MID)}, [(DOOR[0], MID)]
while stack:
    c, r = stack.pop()
    for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        n = (c + dc, r + dr)
        if 0 <= n[0] < N and 0 <= n[1] < N and n not in seen and walk_ok(*n):
            seen.add(n)
            stack.append(n)
room = [(c, r) for r in range(N) for c in range(RW0, RW1 + 1) if walk_ok(c, r)]
unreached = [p for p in room if p not in seen]
assert not unreached, unreached

L = {
    "version": 1,
    "cols": N,
    "rows": N,
    "layoutRevision": OLD.get("layoutRevision", 1),
    "tiles": T,
    "tileColors": TC,
    "furniture": furniture,
    "pets": OLD.get("pets", []),
    "carpetTiles": [None] * (N * N),
    "areas": [a for a in OLD["areas"] if a["label"] in ("superagent", "ezphot")],
    "areaTiles": A,
}
json.dump(L, open(sys.argv[2], "w"), separators=(",", ":"))
print(f"ok: {sys.argv[2]}  {N}x{N}, {len(furniture)} items, {len(room)} walkable room tiles")
