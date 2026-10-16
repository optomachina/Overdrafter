"""Minimal GLB reader and watertightness check (OVD-802), struct + numpy only.

A mesh is watertight when, after merging coincident vertices, every undirected
edge is shared by exactly two triangles. Meshes exported per face (one glTF
primitive per B-rep face) share no vertex indices, so merging by position is
what joins them.

Only .glb files under $JARVIS_DEMO_ROOT/runs (default ~/overnight/jarvis/runs)
are read.

Usage: python glb_check.py <file.glb>   -> prints a JSON report, exits 0 if watertight
"""

import json
import os
import struct
import sys
from pathlib import Path

import numpy as np

GLB_MAGIC = 0x46546C67  # "glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
COMPONENT_DTYPES = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
TYPE_WIDTHS = {"SCALAR": 1, "VEC3": 3}
MODE_TRIANGLES = 4


def runs_root():
    return (Path(os.environ.get("JARVIS_DEMO_ROOT", Path.home() / "overnight" / "jarvis")) / "runs").resolve()


def checked_glb_path(path):
    """Resolve path (following symlinks) and require an existing .glb file inside the runs dir."""
    resolved = Path(path).resolve()
    root = runs_root()
    if resolved.suffix.lower() != ".glb" or not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError(f"GLB path must be an existing .glb file under {root}")
    return resolved


def read_glb(path):
    data = checked_glb_path(path).read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or length != len(data):
        raise ValueError(f"not a glTF 2.0 binary: magic={magic:#x} version={version} length={length}/{len(data)}")
    offset, doc, binary = 12, None, b""
    while offset < length:
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8: offset + 8 + chunk_length]
        if chunk_type == CHUNK_JSON:
            doc = json.loads(chunk.decode("utf-8"))
        elif chunk_type == CHUNK_BIN and not binary:
            binary = chunk
        offset += 8 + chunk_length
    if doc is None:
        raise ValueError("GLB has no JSON chunk")
    return doc, binary


def read_accessor(doc, binary, index):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    dtype = np.dtype(COMPONENT_DTYPES[accessor["componentType"]])
    width = TYPE_WIDTHS[accessor["type"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", dtype.itemsize * width)
    count = accessor["count"]
    if stride == dtype.itemsize * width:
        return np.frombuffer(binary, dtype=dtype, count=count * width, offset=start).reshape(count, width)
    return np.array([np.frombuffer(binary, dtype=dtype, count=width, offset=start + i * stride) for i in range(count)])


def node_matrices(doc):
    """World matrix per mesh index, walking the default scene's node tree."""
    def local(node):
        if "matrix" in node:
            return np.array(node["matrix"], dtype=float).reshape(4, 4).T
        t = np.eye(4)
        t[:3, 3] = node.get("translation", [0, 0, 0])
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        r = np.eye(4)
        r[:3, :3] = [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
        s = np.diag(list(node.get("scale", [1, 1, 1])) + [1])
        return t @ r @ s

    found = []

    def walk(index, parent):
        node = doc["nodes"][index]
        world = parent @ local(node)
        if "mesh" in node:
            found.append((node["mesh"], world))
        for child in node.get("children", []):
            walk(child, world)

    scene = doc.get("scenes", [{}])[doc.get("scene", 0)] if doc.get("scenes") else {"nodes": list(range(len(doc.get("nodes", []))))}
    for root in scene.get("nodes", []):
        walk(root, np.eye(4))
    return found


def triangles(path):
    """All triangles in world space (glTF units: metres), shape (n, 3, 3)."""
    doc, binary = read_glb(path)
    out = []
    for mesh_index, world in node_matrices(doc):
        for primitive in doc["meshes"][mesh_index]["primitives"]:
            if primitive.get("mode", MODE_TRIANGLES) != MODE_TRIANGLES:
                raise ValueError(f"unsupported primitive mode {primitive.get('mode')}")
            positions = read_accessor(doc, binary, primitive["attributes"]["POSITION"]).astype(float)
            positions = (np.c_[positions, np.ones(len(positions))] @ world.T)[:, :3]
            if "indices" in primitive:
                indices = read_accessor(doc, binary, primitive["indices"]).reshape(-1, 3)
            else:
                indices = np.arange(len(positions)).reshape(-1, 3)
            out.append(positions[indices])
    return np.concatenate(out) if out else np.zeros((0, 3, 3))


def watertight_report(path, tolerance=1e-7):
    tris = triangles(path)
    points = tris.reshape(-1, 3)
    # Merge coincident vertices: quantise to the tolerance, then index unique keys.
    keys = np.round(points / tolerance).astype(np.int64)
    _, merged = np.unique(keys, axis=0, return_inverse=True)
    merged = merged.reshape(-1, 3)
    degenerate = (merged[:, 0] == merged[:, 1]) | (merged[:, 1] == merged[:, 2]) | (merged[:, 0] == merged[:, 2])
    faces = merged[~degenerate]
    edges = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    lo, hi = points.min(axis=0), points.max(axis=0)
    return {
        "triangles": int(len(faces)),
        "degenerateTriangles": int(degenerate.sum()),
        "vertices": int(merged.max() + 1) if len(merged) else 0,
        "edges": int(len(counts)),
        "edgesNotShared2": int((counts != 2).sum()),
        "watertight": bool(len(faces) > 0 and (counts == 2).all()),
        "bboxUnits": [float(v) for v in (hi - lo)],
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: glb_check.py <file.glb>", file=sys.stderr)
        sys.exit(64)
    report = watertight_report(sys.argv[1])
    print(json.dumps(report))
    sys.exit(0 if report["watertight"] else 1)
