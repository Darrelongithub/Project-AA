/** NOIR inline-SVG identity assets. Organization-owned marks remain supported separately. */
const AA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="#672b3c"/><path d="M9 34 18.7 13l9.7 21M13.1 26h11.2M20 34 29.7 13l9.7 21M24.1 26h11.2" fill="none" stroke="#c7b69e" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="6" r="1.15" fill="#f2ece3"/></svg>`;
const AA_BANNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="116" viewBox="0 0 720 116"><rect width="720" height="116" rx="16" fill="#211c1e"/><path d="M0 0h720v4H0z" fill="#91485b"/><rect x="26" y="22" width="72" height="72" rx="18" fill="#672b3c"/><path d="m39 77 15-39 15 39M45 62h18M56 77l15-39 15 39M62 62h18" fill="none" stroke="#c7b69e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="122" y="55" fill="#f2ece3" font-family="Georgia,serif" font-size="28" letter-spacing="1">PROJECT AA</text><text x="124" y="79" fill="#b5a9a5" font-family="Arial,sans-serif" font-size="12" letter-spacing="2.2">CASE INTAKE WORKSPACE</text><path d="M635 58h52" stroke="#c7b69e" stroke-width="1" opacity=".7"/><circle cx="692" cy="58" r="3" fill="#c7b69e"/></svg>`;
const b64 = (value: string): string => Buffer.from(value).toString("base64");
export const LOGO_BASE64 = b64(AA_SVG);
export const LOGO_WHITE_BASE64 = b64(AA_SVG);
export const FAVICON_BASE64 = b64(AA_SVG);
export const EMAIL_BANNER_BASE64 = b64(AA_BANNER_SVG);
