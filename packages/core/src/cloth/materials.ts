/**
 * Fabric presets for the cloth simulation. Weights are real fabric weights;
 * the stiffness values are tuned so each fabric drapes like its namesake on a
 * walking character. Weight changes how far the cloth sags under gravity and
 * how much it lags behind the body; air drag affects light fabrics most, so
 * silk floats and leather swings.
 */
export type ClothMaterialId = 'silk' | 'cotton' | 'wool' | 'denim' | 'leather';

export interface ClothMaterial {
  id: ClothMaterialId;
  label: string;
  hint: string;
  /** Weight per area, kg/m². */
  density: number;
  /** Bending rigidity (N·m): high holds its shape, low drapes. */
  bend: number;
  /** Resistance to stretching (N/m per m² of cloth). */
  stretch: number;
  /** How fast motion relative to the body dies out (1/s): internal friction. */
  damping: number;
  /** How strongly the cloth grips the body where it touches it (N/m per m²). */
  grip: number;
}

export const CLOTH_MATERIALS: readonly ClothMaterial[] = [
  { id: 'silk', label: 'Silk', hint: 'Very light and fluid, floats and ripples', density: 0.07, bend: 2e-6, stretch: 200000, damping: 0.8, grip: 400 },
  { id: 'cotton', label: 'Cotton', hint: 'Light, soft folds', density: 0.15, bend: 1.2e-5, stretch: 300000, damping: 1.5, grip: 600 },
  { id: 'wool', label: 'Wool', hint: 'Medium weight, thick soft folds', density: 0.3, bend: 4e-5, stretch: 250000, damping: 2.5, grip: 800 },
  { id: 'denim', label: 'Denim', hint: 'Heavy and stiff, few large folds', density: 0.45, bend: 2e-4, stretch: 450000, damping: 3.5, grip: 1100 },
  { id: 'leather', label: 'Leather', hint: 'Heaviest and stiffest, holds its shape and swings', density: 0.9, bend: 8e-4, stretch: 600000, damping: 4, grip: 1500 },
];

export function clothMaterial(id: string): ClothMaterial | undefined {
  return CLOTH_MATERIALS.find((m) => m.id === id);
}

/** A sensible starting fabric for a part, from its name (null: not cloth, e.g. skin, hair or shoes). */
export function guessClothMaterial(partName: string): ClothMaterialId | null {
  const n = partName.toLowerCase();
  if (/skin|hair|head|face|hand|shoe|boot|sock|eye|teeth|body|glove|helmet|armou?r|hat/.test(n)) return null;
  if (/jean|denim|trouser|pant|bottom|short/.test(n)) return 'denim';
  if (/leather|jacket|coat|vest/.test(n)) return 'leather';
  if (/silk|scarf|veil|dress|gown|robe|sash/.test(n)) return 'silk';
  if (/wool|sweater|jumper|cloak|cape|knit/.test(n)) return 'wool';
  if (/top|shirt|tee|blouse|tunic|hoodie|skirt|kilt|cloth|garment|sleeve|apron|uniform|suit/.test(n)) return 'cotton';
  return null;
}
