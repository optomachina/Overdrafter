"""CAD-neutral stand-in for the Jarvis Workstation design step (demo only).

Builds a three part assembly (base plate, L bracket, clevis pin) with build123d,
exports one STEP per part plus the assembly STEP, renders a PNG, and checks the
geometry. It is not SolidWorks evidence and never touches a hosted service.

Usage: python assembly.py <request.json> <output_dir>
"""

import json
import math
import sys
from pathlib import Path

from build123d import Align, Box, Compound, Cylinder, GeomType, Location, Pos, Rot, export_step

PLATE = (120.0, 80.0, 8.0)
FLANGE = (60.0, 40.0, 8.0)
UPRIGHT_HEIGHT = 50.0
MOUNT_HOLE = 6.6
PIN_CLEARANCE = 0.2
PIN_HEAD = (6.0, 4.0)  # extra head diameter, head length


def build(params):
    pin_d = params["pinDiameterMm"]
    plate_x, plate_y, plate_t = PLATE
    flange_x, flange_y, flange_t = FLANGE

    plate = Box(plate_x, plate_y, plate_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x in (-50.0, 50.0):
        for y in (-30.0, 30.0):
            plate -= Pos(x, y, 0) * Cylinder(MOUNT_HOLE / 2, plate_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x in (-20.0, 20.0):
        plate -= Pos(x, -10.0, 0) * Cylinder(MOUNT_HOLE / 2, plate_t, align=(Align.CENTER, Align.CENTER, Align.MIN))

    pin_axis_z = plate_t + flange_t + UPRIGHT_HEIGHT * 0.6
    bracket = Pos(0, -10.0, plate_t) * Box(flange_x, flange_y, flange_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    bracket += Pos(0, 10.0 - flange_t / 2, plate_t) * Box(
        flange_x, flange_t, flange_t + UPRIGHT_HEIGHT, align=(Align.CENTER, Align.CENTER, Align.MIN)
    )
    for x in (-20.0, 20.0):
        bracket -= Pos(x, -10.0, plate_t) * Cylinder(MOUNT_HOLE / 2, flange_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    hole_d = pin_d + PIN_CLEARANCE
    bracket -= Pos(0, 10.0 - flange_t / 2, pin_axis_z) * Rot(90, 0, 0) * Cylinder(hole_d / 2, flange_t * 3)

    shank = flange_t + 2 * params["pinProtrusionMm"]
    head_d, head_l = pin_d + PIN_HEAD[0], PIN_HEAD[1]
    pin = Cylinder(pin_d / 2, shank, align=(Align.CENTER, Align.CENTER, Align.MIN))
    pin += Pos(0, 0, shank) * Cylinder(head_d / 2, head_l, align=(Align.CENTER, Align.CENTER, Align.MIN))
    upright_back = 10.0 - flange_t
    pin = Location((0, upright_back - params["pinProtrusionMm"], pin_axis_z)) * Rot(-90, 0, 0) * pin

    plate.label, bracket.label, pin.label = "base_plate", "l_bracket", "clevis_pin"
    return {"base_plate": plate, "l_bracket": bracket, "clevis_pin": pin}, {
        "pinAxisZ": pin_axis_z,
        "holeDiameterMm": hole_d,
        "headDiameterMm": head_d,
    }


def checks(parts, derived, params):
    results = []

    def record(name, ok, detail):
        results.append({"check": name, "pass": bool(ok), "detail": detail})

    for name, part in parts.items():
        solids = part.solids()
        record(f"{name}: one valid solid", len(solids) == 1 and part.is_valid, f"solids={len(solids)} valid={part.is_valid}")
    names = list(parts)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            overlap = parts[a].intersect(parts[b])
            volume = sum(solid.volume for solid in overlap.solids()) if overlap else 0.0
            record(f"no interference {a}/{b}", volume < 1e-6, f"overlap_mm3={volume:.6f}")
    # Measured from the solids, not from the build constants.
    def y_cylinders(part):
        return [f for f in part.faces().filter_by(GeomType.CYLINDER) if abs(abs(f.axis_of_rotation.direction.Y) - 1) < 1e-9]

    holes = y_cylinders(parts["l_bracket"])
    shank = min(y_cylinders(parts["clevis_pin"]), key=lambda f: f.radius, default=None)
    if len(holes) == 1 and shank is not None:
        hole = holes[0]
        clearance = 2 * (hole.radius - shank.radius)
        record("pin clearance fit", 0 < clearance <= 0.5, f"measured_diametral_clearance_mm={clearance:.3f}")
        hp, sp = hole.axis_of_rotation.position, shank.axis_of_rotation.position
        offset = math.hypot(hp.X - sp.X, hp.Z - sp.Z)
        record("pin coaxial with hole", offset < 1e-6, f"axis_offset_mm={offset:.6f}")
    else:
        record("pin clearance fit", False, f"bracket_y_holes={len(holes)} pin_shank={'found' if shank else 'missing'}")
    pin_box = parts["clevis_pin"].bounding_box()
    upright = parts["l_bracket"].bounding_box()
    record(
        "pin spans upright",
        pin_box.min.Y < upright.max.Y - FLANGE[2] and pin_box.max.Y > upright.max.Y,
        f"pin_y=[{pin_box.min.Y:.2f},{pin_box.max.Y:.2f}] upright_y=[{upright.max.Y - FLANGE[2]:.2f},{upright.max.Y:.2f}]",
    )
    plate_box = parts["base_plate"].bounding_box()
    seated = (
        abs(upright.min.Z - plate_box.max.Z) < 1e-6
        and plate_box.min.X <= upright.min.X and upright.max.X <= plate_box.max.X
        and plate_box.min.Y <= upright.min.Y and upright.max.Y <= plate_box.max.Y
    )
    record("bracket seated on plate", seated, f"bracket_min_z={upright.min.Z:.3f} plate_top_z={plate_box.max.Z:.3f}")
    return results


def render_png(parts, path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    import numpy as np
    from matplotlib.colors import to_rgb

    colors = {"base_plate": "#8c9aa8", "l_bracket": "#d08a3c", "clevis_pin": "#3c6fd0"}
    light = np.array([0.4, 0.8, 0.6]) / np.linalg.norm([0.4, 0.8, 0.6])
    fig = plt.figure(figsize=(8, 6), dpi=150)
    ax = fig.add_subplot(projection="3d", computed_zorder=False)
    # Painter order plate, bracket, pin: the camera sits on the pin head side.
    for zorder, (name, part) in enumerate(parts.items()):
        vertices, triangles = part.tessellate(0.2, math.radians(10))
        points = np.array([(v.X, v.Y, v.Z) for v in vertices])
        tris = points[np.array(triangles)]
        normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        normals /= np.linalg.norm(normals, axis=1, keepdims=True) + 1e-12
        shade = 0.45 + 0.55 * np.abs(normals @ light)
        facecolors = np.clip(np.outer(shade, to_rgb(colors[name])), 0, 1)
        ax.add_collection3d(Poly3DCollection(tris, facecolors=facecolors, edgecolor="none", zorder=zorder))
    ax.set_xlim(-60, 60)
    ax.set_ylim(-60, 60)
    ax.set_zlim(0, 80)
    ax.set_box_aspect((1, 1, 80 / 120))
    ax.view_init(elev=22, azim=55)
    ax.set_xlabel("X mm")
    ax.set_ylabel("Y mm")
    ax.set_zlabel("Z mm")
    ax.set_title("Jarvis demo: plate + L bracket + clevis pin (CAD-neutral, not SolidWorks)")
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def main():
    request_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    request = json.loads(request_path.read_text())
    params = request["params"]
    out_dir.mkdir(parents=True, exist_ok=True)
    parts, derived = build(params)
    files = {}
    for name, part in parts.items():
        target = out_dir / f"{name}.step"
        export_step(part, str(target))
        files[name] = target.name
    assembly = Compound(label="jarvis_demo_assembly", children=list(parts.values()))
    export_step(assembly, str(out_dir / "assembly.step"))
    files["assembly"] = "assembly.step"
    results = checks(parts, derived, params)
    summary = {
        "requestId": request["id"],
        "engine": "build123d (OpenCascade), CAD-neutral stand-in",
        "native": False,
        "params": params,
        "derived": derived,
        "volumesMm3": {name: round(part.volume, 3) for name, part in parts.items()},
        "checks": results,
        "allChecksPass": all(r["pass"] for r in results),
        "files": files,
    }
    (out_dir / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
    render_png(parts, out_dir / "assembly.png")
    summary["files"]["render"] = "assembly.png"
    (out_dir / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"allChecksPass": summary["allChecksPass"], "files": files}))
    return 0 if summary["allChecksPass"] else 2


if __name__ == "__main__":
    sys.exit(main())
