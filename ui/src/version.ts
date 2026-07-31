declare const __APP_VERSION__: string | undefined;

const FALLBACK_VERSION = '0.0.0.0';

export const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim()
    ? __APP_VERSION__
    : FALLBACK_VERSION;
