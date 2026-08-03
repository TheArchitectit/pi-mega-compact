declare global {
  interface Window {
    MEGACOMPACT_NEW_UI?: boolean;
  }
}

/** True when the vbrainstorm visual design migration is enabled (default ON). */
export const NEW_UI = (): boolean => window.MEGACOMPACT_NEW_UI !== false;

export {};
