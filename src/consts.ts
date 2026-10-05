/** Site name. Appended to every page title and used as `og:site_name`. */
export const SITE_NAME = "Site";
/** Fallback meta description for pages that don't set their own. */
export const SITE_DESCRIPTION = "Built from Figma with the Relume Styleguide.";
/** Canonical origin. Resolves canonical URLs and social images. */
export const SITE_URL = "https://example.com";
/** BCP 47 locale tag used to format dates and numbers. */
export const SITE_LOCALE = "en-US";
/** Routes excluded from search. Surrounding slashes are ignored. */
export const NOINDEX_ROUTES: string[] = ["/404", "/style-guide"];
