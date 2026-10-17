"""CAD-neutral plate recipe for the Jarvis CAD agent (OVD-802).

Builds a 4.000 in (101.6 mm) square plate with build123d, exports STEP (the
authoritative artifact), a binary glTF (.glb, a derived review view) and two PNG
renders (iso and top), then checks the output: exactly one valid solid, the STEP
bounding box re-measured from the exported file, and a watertight GLB. Not
SolidWorks evidence; never touches a hosted service.

Usage: python plate.py <request.json> <output_dir>
"""

import json
import math
import os
import re
import sys
from pathlib import Path

from build123d import Align, Box, Cylinder, Pos, export_gltf, export_step, import_step

from glb_check import watertight_report

EDGE_MM = 101.6
# Thinner than 0.5 mm is foil, not a machinable plate; thicker than 50 mm is a block.
THICKNESS_MIN_MM = 0.5
THICKNESS_MAX_MM = 50.0
BBOX_TOLERANCE_MM = 0.01
HOLE_INSET_MM = 12.7
HOLE_PATTERNS = {
    "none": None,
    "four_corner_m5": 5.5,  # M5 normal clearance
    "four_corner_1_4_20": 6.6,  # 1/4-20 close clearance
}


def validate(params):
    if params.get("recipe") != "plate":
        return f"recipe must be plate, got {params.get('recipe')!r}"
    if params.get("edgeMm") != EDGE_MM:
        return f"this recipe builds only a {EDGE_MM} mm square plate, got {params.get('edgeMm')!r}"
    thickness = params.get("thicknessMm")
    if not isinstance(thickness, (int, float)) or not (THICKNESS_MIN_MM <= thickness <= THICKNESS_MAX_MM):
        return f"thickness must be {THICKNESS_MIN_MM} to {THICKNESS_MAX_MM} mm, got {thickness!r}"
    if params.get("holePattern") not in HOLE_PATTERNS:
        return f"holePattern must be one of {', '.join(HOLE_PATTERNS)}, got {params.get('holePattern')!r}"
    return None


def build(params):
    thickness = float(params["thicknessMm"])
    plate = Box(EDGE_MM, EDGE_MM, thickness, align=(Align.CENTER, Align.CENTER, Align.MIN))
    hole_d = HOLE_PATTERNS[params["holePattern"]]
    if hole_d:
        offset = EDGE_MM / 2 - HOLE_INSET_MM
        for x in (-offset, offset):
            for y in (-offset, offset):
                plate -= Pos(x, y, 0) * Cylinder(hole_d / 2, thickness, align=(Align.CENTER, Align.CENTER, Align.MIN))
    plate.label = "plate"
    return plate


def size(box):
    return {"x": round(box.size.X, 6), "y": round(box.size.Y, 6), "z": round(box.size.Z, 6)}


def checks(plate, step_shape, glb_report, params):
    results = []

    def record(name, ok, detail):
        results.append({"check": name, "pass": bool(ok), "detail": detail})

    solids = plate.solids()
    record("one valid solid", len(solids) == 1 and plate.is_valid, f"solids={len(solids)} valid={plate.is_valid}")
    step_solids = step_shape.solids()
    record("STEP holds one valid solid", len(step_solids) == 1 and step_shape.is_valid, f"solids={len(step_solids)}")
    measured = size(step_shape.bounding_box())
    expected = {"x": EDGE_MM, "y": EDGE_MM, "z": float(params["thicknessMm"])}
    worst = max(abs(measured[a] - expected[a]) for a in "xyz")
    record("STEP bounding box", worst <= BBOX_TOLERANCE_MM, f"measured_mm={measured} expected_mm={expected} worst_dev_mm={worst:.6f}")
    record(
        "GLB watertight",
        glb_report["watertight"],
        f"triangles={glb_report['triangles']} edges={glb_report['edges']} edges_not_shared_by_2={glb_report['edgesNotShared2']}",
    )
    return results, measured


def render_pngs(plate, iso_path, top_path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.colors import to_rgb
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    vertices, triangles = plate.tessellate(0.05, math.radians(5))
    points = np.array([(v.X, v.Y, v.Z) for v in vertices])
    tris = points[np.array(triangles)]
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normals /= np.linalg.norm(normals, axis=1, keepdims=True) + 1e-12
    light = np.array([0.4, 0.5, 0.8]) / np.linalg.norm([0.4, 0.5, 0.8])
    shade = 0.45 + 0.55 * np.abs(normals @ light)
    facecolors = np.clip(np.outer(shade, to_rgb("#8c9aa8")), 0, 1)
    box = plate.bounding_box()
    half = EDGE_MM / 2 + 5
    for path, (elev, azim), label in ((iso_path, (30, -55), "iso"), (top_path, (90, -90), "top")):
        fig = plt.figure(figsize=(6, 6), dpi=150)
        ax = fig.add_subplot(projection="3d")
        # Back-face culling: matplotlib sorts polygons by mean depth only, so hidden
        # faces of a thin plate bleed through unless they are dropped.
        e, a = math.radians(elev), math.radians(azim)
        toward_camera = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
        visible = normals @ toward_camera > 1e-6
        ax.add_collection3d(
            Poly3DCollection(tris[visible], facecolors=facecolors[visible], edgecolors=facecolors[visible], linewidths=0.3)
        )
        ax.set_xlim(-half, half)
        ax.set_ylim(-half, half)
        ax.set_zlim(0, max(box.size.Z, 1.0))
        ax.set_box_aspect((1, 1, max(box.size.Z, 1.0) / (2 * half)))
        if label == "top":
            ax.set_proj_type("ortho")
            ax.set_zticks([])
        ax.view_init(elev=elev, azim=azim)
        ax.set_xlabel("X mm")
        ax.set_ylabel("Y mm")
        ax.set_title(f"Jarvis CAD agent: {EDGE_MM} mm square plate, {box.size.Z:g} mm ({label}, CAD-neutral)")
        fig.savefig(path, bbox_inches="tight")
        plt.close(fig)


def main():
    runs_root = Path(os.environ.get("JARVIS_DEMO_ROOT", Path.home() / "overnight" / "jarvis")).resolve() / "runs"
    out_dir = Path(sys.argv[2]).resolve()
    if out_dir.parent != runs_root or not re.fullmatch(r"jd-[\w-]+", out_dir.name):
        print(f"output_dir must be a jd-* directory directly under {runs_root}", file=sys.stderr)
        return 64
    if Path(sys.argv[1]).resolve() != out_dir / "request.json":
        print("request path must be <output_dir>/request.json", file=sys.stderr)
        return 64
    request = json.loads((out_dir / "request.json").read_text())
    params = request["params"]
    refusal = validate(params)
    if refusal:
        print(refusal, file=sys.stderr)
        return 64
    plate = build(params)
    files = {"step": "plate.step", "glb": "plate.glb", "iso": "plate-iso.png", "top": "plate-top.png"}
    export_step(plate, str(out_dir / files["step"]))
    export_gltf(plate, str(out_dir / files["glb"]), binary=True, linear_deflection=0.01, angular_deflection=0.1)
    step_shape = import_step(str(out_dir / files["step"]))
    glb_report = watertight_report(str(out_dir / files["glb"]))
    results, measured = checks(plate, step_shape, glb_report, params)
    render_pngs(plate, out_dir / files["iso"], out_dir / files["top"])
    summary = {
        "requestId": request["id"],
        "recipe": "plate",
        "engine": "build123d (OpenCascade), CAD-neutral stand-in",
        "native": False,
        "params": params,
        "stepBboxMm": measured,
        "volumeMm3": round(plate.volume, 3),
        "glb": glb_report,
        "checks": results,
        "allChecksPass": all(r["pass"] for r in results),
        "files": files,
    }
    (out_dir / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"allChecksPass": summary["allChecksPass"], "stepBboxMm": measured, "files": files}))
    return 0 if summary["allChecksPass"] else 2


if __name__ == "__main__":
    sys.exit(main())
