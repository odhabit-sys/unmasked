import { defineConfig } from 'vite';

// GitHub Pages serves the site from https://odhabit-sys.github.io/unmasked/,
// so production builds (and `vite preview` of them) use that base path.
// Local dev stays at "/".
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/unmasked/' : '/',
}));
