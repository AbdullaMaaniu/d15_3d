# @rigforge/cli

Auto-rig and animate GLB models from the command line, e.g. a folder of Meshy.ai exports.
Skins and animations are written straight into the glTF, so materials and textures pass through untouched.

```bash
rigforge rig hero.glb                                 # → hero.rigged.glb (idle, walk, run, jump)
rigforge rig exports/*.glb -o rigged/ --clips all     # batch, every humanoid preset
rigforge rig dog.glb -t quadruped --clips walk,trot   # animals get procedural gaits
rigforge rig hero.glb -p lossless --report report.json
rigforge clips                                        # list clip ids (add -t quadruped for gaits)
rigforge info hero.rigged.glb
MESHY_API_KEY=msy_... rigforge meshy list             # your finished Meshy.ai models
MESHY_API_KEY=msy_... rigforge meshy rig <task-id>    # download and rig in one go
```

Options: `--height <m>`, `--no-fingers`, `--resolution <n>` (skinning voxel resolution), `-p web|mobile|lossless`.
Texture resizing and WebP conversion run in the browser editor; the CLI keeps original textures.
