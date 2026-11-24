// Build version, from package.json through the Vite define in vite.config.ts and
// vite.single.config.ts. Shown small on the title, Pause and Credits screens.

declare const __BRUSHSTEEL_VERSION__: string | undefined;

export const VERSION: string = typeof __BRUSHSTEEL_VERSION__ === 'string' ? __BRUSHSTEEL_VERSION__ : 'dev';
export const versionLabel = (): string => `v${VERSION}`;
