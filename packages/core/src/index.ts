export * from './skeleton';
export * from './kernels';
export type { VoxelGrid } from './voxel/grid';
export { voxelizeTS } from './voxel/voxelize';
export { boneDistancesTS, type GeodesicInput } from './voxel/geodesic';

export { mergeSceneMeshes, toStandardMaterial, type PreparedMesh } from './mesh/merge';
export { analyzeMesh, removeDegenerateTriangles, weldByPosition, type MeshReport, type TextureInfo } from './mesh/analyze';
export { computeNormalization, applyNormalization, guessOrientation, type Normalization, type NormalizeOptions } from './mesh/normalize';
export { createMannequin, type MannequinOptions } from './mesh/mannequin';

export { detectHumanoid, symmetrizeJoints, type DetectOptions, type DetectResult } from './rig/landmarks';
export { detectFingers, type FingerDetection } from './rig/fingers';
export { computeSkinWeights, computeSkinWeightsAsync, boneSegments, type SkinWeights, type WeightOptions } from './rig/weights';
export { buildSkinnedCharacter, resetPose, type RiggedCharacter } from './rig/build';

export { autoMapBones, normalizeBoneName, type BoneMap, type BoneMapResult } from './anim/bonemap';
export {
  bindSkeleton,
  extractNormalizedClip,
  bakeClip,
  retargetClip,
  type NormalizedClip,
  type SkeletonBinding,
  type BakeOptions,
} from './anim/retarget';
export { sliceClip, alignHeading, findLoop, makeSeamlessLoop, resampleClip, mirrorClip, poseDistance, clipDuration } from './anim/clipTools';
export { encodeClip, decodeClip, type EncodedClip, type PresetPack } from './anim/codec';

export { exportCharacter, optimizeDocument, EXPORT_PRESETS, toGLB, createIO, sizeBreakdown, type ExportOptions, type ExportPreset, type ExportResult, type SizeBreakdown } from './export/export';
export { generateSnippet, type SnippetInput, type SnippetKind } from './export/snippets';
export { createPaintContext, applyBrush, snapshotWeights, restoreWeights, type BrushMode, type BrushStroke, type PaintContext } from './rig/paint';
export {
  emptyKeyLayer, keyCount, keyTimes, setBoneKey, setHipsKey, deleteKeys, cloneLayer, applyKeyLayer,
  sampleBoneOffset, sampleHipsOffset, rigLocalToNormalized, rigHipsToNormalized, sampleNormalized,
  sampleNormalizedHips, bindPoseClip, type KeyLayer, type KeyChannel,
} from './anim/keys';
export {
  splitParts, buildPropCharacter, propMotionKeys, bakePropClip, setPropKey, deletePropKeys, propKeyTimes,
  type MeshPart, type PartSplit, type PropBone, type PropRig, type PropKeys, type PropMotion,
} from './rig/prop';
export { QUADRUPED_DEFS, TAIL_BONES, legBone, detectQuadruped, guessQuadrupedOrientation, type QuadrupedDetectResult } from './rig/quadruped';
export { createQuadrupedMannequin } from './mesh/mannequin';
export { quadrupedGaits, type GaitClip, type GaitId } from './anim/gaits';
export { creatureDefs, autoTails, boneChain, mirrorSubtree, isLeaf, type CreatureBone } from './rig/creature';
export { rigDocument, type RigDocumentOptions, type RigDocumentReport } from './export/document';
export { MeshyClient, MeshyError, normalizeTask, type MeshyKind, type MeshyTask } from './meshy';
export {
  REMESH_TARGETS,
  arraysToGeometry,
  decodeFaceSizes,
  encodeFaceSizes,
  geometryToArrays,
  quadOutputToArrays,
  remeshTriangles,
  toOBJ,
  type MeshArrays,
  type Topology,
} from './mesh/remesh';
