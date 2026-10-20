"""Convert supplied IFC geometry to a compact, material-grouped Y-up GLB.

Usage: python tools/export_city_ifc.py INPUT.ifc OUTPUT.glb
Requires ifcopenshell, numpy, trimesh. Geometry documentation:
https://docs.ifcopenshell.org/ifcopenshell-python/geometry_processing.html
"""
import sys
from pathlib import Path
import numpy as np
import ifcopenshell
import ifcopenshell.geom
import trimesh

source, output = sys.argv[1:]
model = ifcopenshell.open(source)
settings = ifcopenshell.geom.settings()
settings.set("use-world-coords", True)
groups = {}
failed = []
for element in model.by_type("IfcProduct"):
    if not element.Representation or element.is_a("IfcOpeningElement"):
        continue
    # Reference roads/site slabs are supplied separately in the editable city.
    if element.Name in {"Site ground", "Reference road"}:
        continue
    try:
        shape = ifcopenshell.geom.create_shape(settings, element)
        geo = shape.geometry
        vertices = np.array(geo.verts).reshape(-1, 3)
        faces = np.array(geo.faces).reshape(-1, 3)
        ids = np.array(geo.material_ids)
        for material_id in np.unique(ids):
            color = (0.73, 0.71, 0.65)
            if 0 <= material_id < len(geo.materials):
                mat = geo.materials[material_id]
                color = (mat.diffuse.r(), mat.diffuse.g(), mat.diffuse.b())
            rgba = tuple(round(float(c) * 255) for c in color) + (255,)
            part = trimesh.Trimesh(vertices=vertices, faces=faces[ids == material_id], process=False)
            groups.setdefault(rgba, []).append(part)
    except Exception as error:
        failed.append((element.id(), str(error)))
if failed:
    raise RuntimeError(f"Unable to convert {len(failed)} elements: {failed[:3]}")
scene = trimesh.Scene()
all_meshes = [trimesh.util.concatenate(parts) for parts in groups.values()]
low = np.min([mesh.bounds[0] for mesh in all_meshes], axis=0)
high = np.max([mesh.bounds[1] for mesh in all_meshes], axis=0)
# Preserve IFC z=0 (ground datum), including the sports centre basement.
origin = np.array([(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, 0])
for (rgba, _), mesh in zip(groups.items(), all_meshes):
    mesh.vertices -= origin
    mesh.vertices = mesh.vertices[:, [0, 2, 1]] * [1, 1, -1]
    mesh.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
        baseColorFactor=rgba, metallicFactor=0.0, roughnessFactor=0.9))
    scene.add_geometry(mesh)
Path(output).parent.mkdir(parents=True, exist_ok=True)
scene.export(output)
print("Dimensions XYZ (IFC metres):", (high-low).tolist())
print("Exported:", output)
