"""Blender 5.2+: blender -b --disable-autoexec --python tools/export_chase_car.py -- INPUT.blend OUTPUT.glb"""
import bpy
import sys
from pathlib import Path
from math import pi
from mathutils import Matrix, Vector

source, output = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=str(Path(source).resolve()), use_scripts=False)
# The source includes a presentation floor, plinth, title, lights and camera.
exclude = {'Display plinth', 'Studio floor', 'Plinth title'}
objects = [o for o in bpy.context.scene.objects
           if o.type in {'MESH', 'FONT', 'CURVE'} and not o.hide_render and o.name not in exclude]
depsgraph = bpy.context.evaluated_depsgraph_get()
converted = []
# Blender front -X -> +Y; glTF export maps Blender +Y to game -Z.
rotation = Matrix.Rotation(-pi / 2, 4, 'Z')
for obj in objects:
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
    mesh.transform(rotation @ obj.matrix_world)
    copy = bpy.data.objects.new(obj.name + '_game', mesh)
    bpy.context.collection.objects.link(copy)
    converted.append(copy)
points = [v.co for obj in converted for v in obj.data.vertices]
low = Vector([min(p[i] for p in points) for i in range(3)])
high = Vector([max(p[i] for p in points) for i in range(3)])
# Keep metre dimensions, centre the footprint and put the tyres on y=0 in glTF.
origin = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
for obj in converted:
    obj.data.transform(Matrix.Translation(-origin))
bpy.ops.object.select_all(action='DESELECT')
for obj in converted:
    obj.select_set(True)
bpy.context.view_layer.objects.active = converted[0]
bpy.ops.object.join()
car = bpy.context.object
car.name = 'sky-chase-car'
Path(output).resolve().parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(Path(output).resolve()), export_format='GLB',
    use_selection=True, export_animations=False, export_cameras=False, export_lights=False,
    export_yup=True)
print('Car dimensions (Blender X/Y/Z, metres):', list(high - low))
print('Exported:', output)
