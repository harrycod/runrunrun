import { defineConfig } from 'vite';

// GitHub Pages는 https://<user>.github.io/<repo>/ 하위 경로로 서비스되므로 상대경로로 빌드한다
export default defineConfig({
  base: './',
});
