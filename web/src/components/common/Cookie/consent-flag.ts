// 📖 Docs: obsidian/frontend/components/common.md

/** localStorage key holding the visitor's cookie choice. */
export const CONSENT_STORAGE_KEY = "cookie-consent-v1";

/**
 * The banner is server-rendered, so it paints with the page instead of after
 * hydration (it is the phone's LCP element). This runs before the banner is
 * parsed — first child of <body> — and marks <html> for a visitor who has
 * already decided; `globals.css` hides the banner under that mark before its
 * first paint, so a returning visitor never sees it flash.
 */
export const CONSENT_FLAG_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  CONSENT_STORAGE_KEY,
)}))document.documentElement.setAttribute("data-consent","")}catch(e){}`;
