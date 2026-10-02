import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Box3, CanvasTexture, DirectionalLight, DodecahedronGeometry, MathUtils, PlaneGeometry, RepeatWrapping, SRGBColorSpace, Vector3, type PerspectiveCamera } from 'three';
import { loadCharacter, type AnimationStateMachine, type Character } from '@rigforge/three';
import { useStore } from '../store';
import { buildGlb } from '../lib/build';

/** What the player is pressing, shared by the keyboard, the touch pad and the scene. */
interface DriveInput {
  keys: Set<string>;
  pad: { x: number; y: number };
  triggers: string[];
}

interface Readout {
  state: string;
  speed: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Rolling hills around a flat spawn pad, scaled to the character (s = height / 1.8 m). */
function terrain(s: number) {
  const height = (x: number, z: number) => {
    const X = x / s, Z = z / s;
    const k = smoothstep(2.5, 7, Math.hypot(X, Z));
    return s * k * (0.35 * Math.sin(X * 0.45) * Math.cos(Z * 0.38) + 0.12 * Math.sin(X * 1.3 + Z * 0.9) + 0.06 * Math.cos(X * 2.1 - Z * 1.7));
  };
  // A few rocks to walk around, from a fixed seed so every run looks the same.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rocks: Array<{ x: number; z: number; r: number }> = [];
  while (rocks.length < 14) {
    const a = rand() * Math.PI * 2, d = (5 + rand() * 18) * s;
    rocks.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: (0.25 + rand() * 0.6) * s });
  }
  return { height, rocks, radius: 28 * s, size: 64 * s };
}

type World = ReturnType<typeof terrain>;

function Ground({ world, s }: { world: World; s: number }) {
  const geometry = useMemo(() => {
    const g = new PlaneGeometry(world.size, world.size, 160, 160);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, world.height(p.getX(i), p.getZ(i)));
    g.computeVertexNormals();
    return g;
  }, [world]);
  const texture = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#5d7a4c';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#54703f';
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillRect(32, 32, 32, 32);
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(world.size / (2 * s), world.size / (2 * s)); // one tile per ~1 m
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [world, s]);
  const rock = useMemo(() => new DodecahedronGeometry(1, 0), []);
  useEffect(() => () => { geometry.dispose(); texture.dispose(); rock.dispose(); }, [geometry, texture, rock]);
  return (
    <>
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial map={texture} roughness={0.95} />
      </mesh>
      {world.rocks.map((r, i) => (
        <mesh key={i} geometry={rock} position={[r.x, world.height(r.x, r.z) + r.r * 0.3, r.z]} scale={[r.r, r.r * 0.8, r.r]} rotation={[i, i * 2, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#8b8680" roughness={0.9} flatShading />
        </mesh>
      ))}
    </>
  );
}

interface SceneProps {
  character: Character;
  machine: AnimationStateMachine;
  world: World;
  s: number;
  input: DriveInput;
  readout: React.MutableRefObject<Readout>;
  onFrame: () => void;
}

function DriveScene({ character, machine, world, s, input, readout, onFrame }: SceneProps) {
  const camera = useThree((st) => st.camera) as PerspectiveCamera;
  const dom = useThree((st) => st.gl.domElement);
  const light = useRef<DirectionalLight>(null);
  const setup = character.controllerSetup;
  const speeds = setup.locomotion.map((l) => l[0]).filter((v) => v > 0);
  const top = speeds.length ? speeds[speeds.length - 1] : 1.4 * s;
  const walk = speeds.length > 1 ? speeds[0] : Math.min(top, 1.4 * s);
  const actions = Object.keys(setup.actions ?? {});
  const motion = useRef({ yaw: 0, speed: 0 });
  const view = useRef({ yaw: 0, pitch: 0.28, dist: 3.4 * s, target: new Vector3(0, s, 0), dragging: false });

  useEffect(() => {
    camera.near = 0.05 * s;
    camera.far = 400 * s;
    camera.updateProjectionMatrix();
  }, [camera, s]);

  // Drag to look around, scroll to zoom.
  useEffect(() => {
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      view.current.dragging = true;
      dom.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const v = view.current;
      v.yaw -= (e.clientX - last.x) * 0.006;
      v.pitch = MathUtils.clamp(v.pitch + (e.clientY - last.y) * 0.004, -0.15, 1.2);
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      last = null;
      view.current.dragging = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      v.dist = MathUtils.clamp(v.dist * Math.pow(1.1, Math.sign(e.deltaY)), 1.2 * s, 12 * s);
    };
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    return () => {
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointercancel', up);
      dom.removeEventListener('wheel', wheel);
    };
  }, [dom, s]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    const obj = character.object;
    const m = motion.current, v = view.current;

    for (const t of input.triggers.splice(0)) {
      if (t === 'jump' && setup.jump) machine.trigger('jump');
      else if (/^\d$/.test(t) && actions[+t - 1]) machine.trigger(actions[+t - 1]);
      else if (setup.actions?.[t]) machine.trigger(t);
    }

    // Camera-relative input: forward is away from the camera.
    const k = input.keys;
    let ix = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + input.pad.x;
    let iy = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + input.pad.y;
    const mag = Math.min(1, Math.hypot(ix, iy));
    if (mag > 0) {
      const len = Math.hypot(ix, iy);
      ix /= len;
      iy /= len;
    }
    const running = k.has('ShiftLeft') || k.has('ShiftRight') || Math.hypot(input.pad.x, input.pad.y) > 0.85;
    const busy = machine.state.startsWith('action:');
    let target = busy ? 0 : mag * (running ? top : walk);
    if (mag > 0.05 && !busy) {
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
      const dx = fx * iy - fz * ix, dz = fz * iy + fx * ix; // forward * iy + right * ix, right = (-cos, 0, sin)
      const want = Math.atan2(dx, dz);
      let diff = want - m.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      m.yaw += diff * Math.min(1, dt * 10);
      // Turn in place first when asked to reverse, rather than moonwalking.
      if (Math.abs(diff) > 2.2) target *= 0.3;
    }
    const accel = Math.max(2, top * 2.5);
    m.speed += MathUtils.clamp(target - m.speed, -accel * 1.4 * dt, accel * dt);

    const p = obj.position;
    p.x += Math.sin(m.yaw) * m.speed * dt;
    p.z += Math.cos(m.yaw) * m.speed * dt;
    const bodyR = 0.25 * s;
    for (const r of world.rocks) {
      const dx = p.x - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz), min = r.r * 0.95 + bodyR;
      if (d < min && d > 1e-6) { p.x = r.x + (dx / d) * min; p.z = r.z + (dz / d) * min; }
    }
    const d = Math.hypot(p.x, p.z);
    if (d > world.radius) { p.x *= world.radius / d; p.z *= world.radius / d; }
    p.y = world.height(p.x, p.z);
    obj.rotation.y = m.yaw;

    machine.set('speed', m.speed);
    character.update(dt);
    readout.current.state = machine.state;
    readout.current.speed = m.speed;

    // Third-person camera: follows smoothly, stays above the ground.
    const want = new Vector3(p.x, p.y + 1.1 * s, p.z);
    v.target.lerp(want, 1 - Math.exp(-dt * 8));
    const cp = Math.cos(v.pitch);
    camera.position.set(v.target.x - Math.sin(v.yaw) * cp * v.dist, v.target.y + Math.sin(v.pitch) * v.dist, v.target.z - Math.cos(v.yaw) * cp * v.dist);
    camera.position.y = Math.max(camera.position.y, world.height(camera.position.x, camera.position.z) + 0.15 * s);
    camera.lookAt(v.target);

    const l = light.current;
    if (l) {
      l.position.set(p.x + 3 * s, p.y + 6 * s, p.z + 2 * s);
      l.target.position.copy(p);
      l.target.updateMatrixWorld();
    }
    onFrame();
  });

  return (
    <>
      <color attach="background" args={['#9db4cb']} />
      <fog attach="fog" args={['#9db4cb', 14 * s, 44 * s]} />
      <hemisphereLight args={['#dfeaff', '#4a5a3c', 1.1]} />
      <directionalLight ref={light} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-4 * s} shadow-camera-right={4 * s} shadow-camera-top={4 * s} shadow-camera-bottom={-4 * s} shadow-camera-far={20 * s} shadow-bias={-0.0004} />
      <Ground world={world} s={s} />
      <primitive object={character.object} />
    </>
  );
}

/** Touch stick: drag from the center; near the rim runs. */
function Pad({ input }: { input: DriveInput }) {
  const knob = useRef<HTMLDivElement>(null);
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  const R = 48;
  const set = (x: number, y: number) => {
    input.pad.x = x;
    input.pad.y = y;
    if (knob.current) knob.current.style.transform = `translate(${x * R}px, ${-y * R}px)`;
  };
  return (
    <div
      className="drive-pad"
      aria-label="Move"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        origin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2, id: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const o = origin.current;
        if (!o || o.id !== e.pointerId) return;
        let x = (e.clientX - o.x) / R, y = -(e.clientY - o.y) / R;
        const l = Math.hypot(x, y);
        if (l > 1) { x /= l; y /= l; }
        set(x, y);
      }}
      onPointerUp={() => { origin.current = null; set(0, 0); }}
      onPointerCancel={() => { origin.current = null; set(0, 0); }}
    >
      <div ref={knob} className="knob" />
    </div>
  );
}

const TYPING = /^(INPUT|SELECT|TEXTAREA)$/;

/** Drives the exported GLB with @rigforge/three: what a game would get from this file. */
export function TestDrive() {
  const glb = useStore((s) => s.testDrive);
  const stale = useStore((s) => !s.exportResult || s.exportResult.glb !== s.testDrive);
  const set = useStore((s) => s.set);
  const [loaded, setLoaded] = useState<{ character: Character; machine: AnimationStateMachine; s: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [footIK, setFootIK] = useState(true);
  const [springs, setSprings] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const input = useRef<DriveInput>({ keys: new Set(), pad: { x: 0, y: 0 }, triggers: [] }).current;
  const readout = useRef<Readout>({ state: '', speed: 0 });
  const stateEl = useRef<HTMLSpanElement>(null);
  const world = useMemo(() => (loaded ? terrain(loaded.s) : null), [loaded]);

  useEffect(() => {
    if (!glb) return;
    let alive = true;
    const url = URL.createObjectURL(new Blob([glb as BlobPart], { type: 'model/gltf-binary' }));
    loadCharacter(url)
      .then((character) => {
        if (!alive) return character.dispose();
        character.object.traverse((o: any) => {
          if (o.isMesh) o.castShadow = true;
        });
        const size = new Box3().setFromObject(character.object).getSize(new Vector3());
        const s = Math.max(0.2, Math.max(size.y, 0.6 * Math.max(size.x, size.z))) / 1.8;
        character.autoBlink();
        setLoaded({ character, machine: character.autoStateMachine(), s });
        setError(null);
      })
      .catch((e) => alive && setError(`Could not load the GLB: ${(e as Error).message}`))
      .finally(() => URL.revokeObjectURL(url));
    return () => {
      alive = false;
    };
  }, [glb]);

  useEffect(() => () => {
    if (!loaded) return;
    loaded.character.dispose();
    loaded.character.object.traverse((o: any) => {
      o.geometry?.dispose?.();
      for (const mat of [o.material].flat()) mat?.dispose?.();
    });
  }, [loaded]);

  // Foot IK needs a two-legged character; quadrupeds and props skip it.
  const canIK = !!loaded && ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].every((b) => loaded.character.bone(b));
  useEffect(() => {
    if (!loaded || !world || !canIK) return;
    loaded.character.enableFootIK(footIK ? { ground: (x, z) => world.height(x, z), maxHipsDrop: 0.35 * loaded.s } : null);
  }, [loaded, world, footIK, canIK]);
  useEffect(() => {
    if (loaded?.character.springs) loaded.character.springs.enabled = springs;
  }, [loaded, springs]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.code === 'Escape') return set('testDrive', null);
      if (TYPING.test(target?.tagName ?? '')) return;
      if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
      // A focused button would also "click" on Space; game keys belong to the game.
      if (target?.tagName === 'BUTTON') target.blur();
      if (e.repeat) return;
      input.keys.add(e.code);
      if (e.code === 'Space') input.triggers.push('jump');
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) input.triggers.push(digit[1]);
    };
    const up = (e: KeyboardEvent) => input.keys.delete(e.code);
    const blur = () => input.keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [input, set]);

  // Handy for automated tests: where the character is and what it's doing.
  useEffect(() => {
    if (!loaded || !world) return;
    (window as any).rigforgeDrive = {
      character: loaded.character,
      scale: loaded.s,
      ground: world.height,
      get state() { return readout.current.state; },
      get speed() { return readout.current.speed; },
      get position() { return loaded.character.object.position.toArray(); },
      teleport(x: number, z: number) { loaded.character.object.position.set(x, world.height(x, z), z); },
    };
    return () => { delete (window as any).rigforgeDrive; };
  }, [loaded, world]);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const res = await buildGlb();
      set('testDrive', res.glb);
    } catch (e) {
      setError(`Rebuild failed: ${(e as Error).message}`);
    } finally {
      setRebuilding(false);
    }
  };

  const setup = loaded?.character.controllerSetup;
  const actions = Object.entries(setup?.actions ?? {});
  let frame = 0;
  const onFrame = () => {
    if (++frame % 6 || !stateEl.current) return;
    const r = readout.current;
    stateEl.current.textContent = `${r.state.replace(/^action:/, '')} · ${r.speed.toFixed(1)} m/s`;
  };

  return (
    <div className="drive">
      {loaded && world && (
        <Canvas shadows dpr={[1, 2]} camera={{ fov: 50, position: [0, 1.6, -3.5] }}>
          <DriveScene character={loaded.character} machine={loaded.machine} world={world} s={loaded.s} input={input} readout={readout} onFrame={onFrame} />
        </Canvas>
      )}
      <div className="overlay">
        <span className="pill"><strong>Test drive</strong> {loaded ? <span ref={stateEl} data-testid="drive-state" /> : error ? null : 'Loading…'}</span>
        {error && <div className="error" role="alert"><span>{error}</span></div>}
        <span className="pill drive-help">WASD / arrows move · Shift run · {setup?.jump ? 'Space jump · ' : ''}{actions.length ? `1–${Math.min(9, actions.length)} actions · ` : ''}drag to look · Esc exit</span>
        {stale && (
          <button className="btn small" onClick={() => void rebuild()} disabled={rebuilding}>
            {rebuilding ? 'Rebuilding…' : 'Settings changed · Rebuild'}
          </button>
        )}
      </div>
      <div className="drive-top">
        {canIK && (
          <label className="pill check"><input type="checkbox" checked={footIK} onChange={(e) => setFootIK(e.target.checked)} /> Foot IK</label>
        )}
        {loaded?.character.springs && (
          <label className="pill check"><input type="checkbox" checked={springs} onChange={(e) => setSprings(e.target.checked)} /> Springs</label>
        )}
        <button className="btn small" onClick={() => set('testDrive', null)}>Exit</button>
      </div>
      <Pad input={input} />
      <div className="drive-actions">
        {actions.slice(0, 9).map(([name], i) => (
          <button key={name} className="btn small" onClick={() => input.triggers.push(name)} title={`Key ${i + 1}`}>
            <kbd>{i + 1}</kbd> {name}
          </button>
        ))}
        {setup?.jump && <button className="btn small primary" onClick={() => input.triggers.push('jump')}><kbd>␣</kbd> Jump</button>}
      </div>
    </div>
  );
}
