# Test corpus

Drop real Meshy.ai exports (`.glb`) in this folder to measure the auto-rigger on them:

```bash
pnpm corpus            # rigs every corpus/*.glb and writes corpus/report.md
```

Model files here are git-ignored, so they're never committed unless their license allows it.
Aim for variety: T-pose and A-pose, stylized and realistic proportions, loose clothing,
fused and separated fingers, and accessories.
