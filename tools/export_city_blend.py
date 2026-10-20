"""Blender 5.2+: blender -b --disable-autoexec --python tools/export_city_blend.py -- INPUT.blend OUTPUT.glb"""
import bpy, sys
from pathlib import Path
from mathutils import Matrix, Vector
source,output=sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.open_mainfile(filepath=str(Path(source).resolve()),use_scripts=False)
deps=bpy.context.evaluated_depsgraph_get()
objects=[]
for obj in list(bpy.context.scene.objects):
    if obj.type not in {'MESH','CURVE','FONT'} or obj.hide_render:
        continue
    # Remove presentation floors, retaining the architecture and its meter units.
    if obj.name.lower() in {'ground','ground plane','preview ground','station forecourt base','base plane'}:
        continue
    if obj.type=='CURVE':
        obj.data.bevel_resolution=min(obj.data.bevel_resolution,1)
    mesh=bpy.data.meshes.new_from_object(obj.evaluated_get(deps),depsgraph=deps)
    mesh.transform(obj.matrix_world)
    copy=bpy.data.objects.new(obj.name+'_game',mesh)
    bpy.context.collection.objects.link(copy);objects.append(copy)
points=[v.co for obj in objects for v in obj.data.vertices]
low=Vector([min(p[i] for p in points) for i in range(3)])
high=Vector([max(p[i] for p in points) for i in range(3)])
origin=Vector(((low.x+high.x)/2,(low.y+high.y)/2,low.z))
for obj in objects:obj.data.transform(Matrix.Translation(-origin))
bpy.ops.object.select_all(action='DESELECT')
for obj in objects:obj.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
bpy.ops.object.join()
Path(output).parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(Path(output).resolve()),export_format='GLB',use_selection=True,
    export_animations=False,export_cameras=False,export_lights=False,export_yup=True)
print("CITY_DIMENSIONS=",list(high-low))
# Headless hosts may hang during PulseAudio teardown after the export has completed.
sys.stdout.flush()
import os
os._exit(0)
