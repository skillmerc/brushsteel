// Duel HUD layout and visibility. Pure: no DOM.

/** Each HUD side (name, ink meter, seals) is min(VW% of the viewport, MAX px) wide. */
export const HUD_SIDE = { vw: 30, max: 340, minMeter: 120 } as const;

/** The CSS width of one HUD side, built from HUD_SIDE so the test and the page agree. */
export const hudSideCss = (): string => `min(${HUD_SIDE.vw}vw,${HUD_SIDE.max}px)`;

/** Ink meter width in px for a viewport this wide: the side width, never under minMeter. */
export function hudMeterPx(viewportWidth: number): number {
  const side = Math.min((viewportWidth * HUD_SIDE.vw) / 100, HUD_SIDE.max);
  return Math.max(side, HUD_SIDE.minMeter);
}

/**
 * Path screens are brush, map, shrine and end. While one is up the duel HUD and its
 * help line stay hidden; they show in a duel and outside Path mode.
 */
export function hudHiddenOn(screen: string): boolean {
  return screen === 'brush' || screen === 'map' || screen === 'shrine' || screen === 'end';
}
