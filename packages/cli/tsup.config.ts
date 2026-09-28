import { defineConfig } from 'tsup';

// Core is bundled (its workspace entry is TypeScript source); runtime libraries stay external.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  noExternal: ['@rigforge/core'],
  external: ['three', /^three\//, /^@gltf-transform\//, 'meshoptimizer'],
});
