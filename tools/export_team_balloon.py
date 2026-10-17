"""Blender 5.2+: blender -b --disable-autoexec --python tools/export_team_balloon.py -- INPUT.blend OUTPUT.glb"""
import bpy
import sys
from pathlib import Path
from mathutils import Matrix, Vector

source, output = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=str(Path(source).resolve()), use_scripts=False)
objects = [o for o in bpy.context.scene.objects
           if o.type in {'MESH', 'FONT', 'CURVE'} and not o.hide_render and o.name != 'Ground']
# Fine piping/ropes need only a small round cross section at normal game distances.
for obj in objects:
    if obj.type == 'CURVE':
        obj.data.bevel_resolution = min(obj.data.bevel_resolution, 1)
depsgraph = bpy.context.evaluated_depsgraph_get()
converted = []
for obj in objects:
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
    mesh.transform(obj.matrix_world)
    copy = bpy.data.objects.new(obj.name + '_game', mesh)
    bpy.context.collection.objects.link(copy)
    converted.append(copy)
points = [v.co for obj in converted for v in obj.data.vertices]
low = Vector([min(p[i] for p in points) for i in range(3)])
high = Vector([max(p[i] for p in points) for i in range(3)])
origin = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
for obj in converted:
    obj.data.transform(Matrix.Translation(-origin))
bpy.ops.object.select_all(action='DESELECT')
for obj in converted:
    obj.select_set(True)
bpy.context.view_layer.objects.active = converted[0]
bpy.ops.object.join()
bpy.context.object.name = 'MV56b-team-balloon'
Path(output).resolve().parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(Path(output).resolve()), export_format='GLB',
    use_selection=True, export_animations=False, export_cameras=False, export_lights=False,
    export_yup=True)
print('Balloon dimensions (Blender X/Y/Z, metres):', list(high - low))
print('Exported:', output)
