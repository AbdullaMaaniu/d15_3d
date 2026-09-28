# @rigforge/r3f

React Three Fiber bindings for RigForge characters.

```tsx
import { Character, Attach, useCharacter, preloadCharacter } from '@rigforge/r3f';

preloadCharacter('/hero.glb');

<Character src="/hero.glb" action={running ? 'Run' : 'Idle'} fade={0.2} lookAt={[0, 1.6, 4]} onFinished={(clip) => {}}>
  <Attach bone="rightHand"><mesh>…</mesh></Attach>
</Character>
```

`useCharacter(src)` returns the underlying `@rigforge/three` `Character` for imperative control.
