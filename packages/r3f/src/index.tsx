import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal, useFrame, type ThreeElements } from '@react-three/fiber';
import { Vector3, type Object3D } from 'three';
import { type Character as RigCharacter, loadCharacter, type LoadOptions, type LookAtOptions, type PlayOptions } from '@rigforge/three';

export { Character as RigCharacter, loadCharacter } from '@rigforge/three';
export type { HumanoidBone, PlayOptions, LookAtOptions } from '@rigforge/three';

const cache = new Map<string, Promise<RigCharacter>>();

/**
 * Loads a character once per URL and returns an independent instance for this
 * component (skeletons can't be shared between scene graph instances).
 */
export function useCharacter(src: string, options?: LoadOptions): RigCharacter | null {
  const [character, setCharacter] = useState<RigCharacter | null>(null);
  useEffect(() => {
    let alive = true;
    let promise = cache.get(src);
    if (!promise) {
      promise = loadCharacter(src, options);
      cache.set(src, promise);
    }
    let instance: RigCharacter | null = null;
    promise
      .then((base) => {
        if (!alive) return;
        instance = base.clone();
        setCharacter(instance);
      })
      .catch((e) => {
        cache.delete(src);
        console.error('[rigforge] failed to load', src, e);
      });
    return () => {
      alive = false;
      instance?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  useFrame((_, delta) => character?.update(delta));
  return character;
}

/** Preloads a character so it's ready before first render. */
export function preloadCharacter(src: string, options?: LoadOptions): void {
  if (!cache.has(src)) cache.set(src, loadCharacter(src, options));
}

const CharacterContext = createContext<RigCharacter | null>(null);

export function useCharacterContext(): RigCharacter | null {
  return useContext(CharacterContext);
}

export type CharacterProps = Omit<ThreeElements['group'], 'children'> & {
  src: string;
  /** Name of the clip to play; changing it crossfades. */
  action?: string;
  fade?: number;
  speed?: number;
  loop?: boolean;
  /** World-space point or object for the head to track. */
  lookAt?: [number, number, number] | Object3D | null;
  lookAtOptions?: LookAtOptions;
  onLoaded?: (character: RigCharacter) => void;
  onFinished?: (clipName: string) => void;
  loaderOptions?: LoadOptions;
  children?: ReactNode;
};

/**
 * <Character src="hero.glb" action="Run" fade={0.2} />
 * Children can use <Attach bone="rightHand"> to mount props on bones.
 */
export function Character({
  src,
  action,
  fade = 0.2,
  speed,
  loop,
  lookAt,
  lookAtOptions,
  onLoaded,
  onFinished,
  loaderOptions,
  children,
  ...group
}: CharacterProps) {
  const character = useCharacter(src, loaderOptions);

  useEffect(() => {
    if (character) onLoaded?.(character);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character]);

  useEffect(() => {
    if (!character || !action) return;
    const opts: PlayOptions = { fade, speed, loop };
    character.play(action, opts);
  }, [character, action, fade, speed, loop]);

  useEffect(() => {
    if (!character || !onFinished) return;
    return character.on('finished', (e) => onFinished(e.name));
  }, [character, onFinished]);

  const target = useMemo(() => {
    if (!lookAt) return null;
    if (Array.isArray(lookAt)) {
      const [x, y, z] = lookAt;
      return { x, y, z };
    }
    return lookAt;
  }, [lookAt]);

  useEffect(() => {
    if (!character) return;
    if (!target) character.lookAt(null);
    else if ((target as Object3D).isObject3D) character.lookAt(target as Object3D, lookAtOptions);
    else {
      const t = target as { x: number; y: number; z: number };
      character.lookAt(new Vector3(t.x, t.y, t.z), lookAtOptions);
    }
  }, [character, target, lookAtOptions]);

  if (!character) return null;
  return (
    <group {...group}>
      <primitive object={character.object} />
      <CharacterContext.Provider value={character}>{children}</CharacterContext.Provider>
    </group>
  );
}

/** Mounts its children on a bone of the enclosing <Character>. */
export function Attach({ bone, children }: { bone: string; children?: ReactNode }) {
  const character = useCharacterContext();
  const target = character?.bone(bone);
  if (!target) return null;
  return createPortal(<>{children}</>, target);
}
