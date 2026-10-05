/** Relume type styles. Used by Heading, Paragraph, and RichText. */
export type TypeStyle =
  | "inherit"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "large"
  | "medium"
  | "regular"
  | "small"
  | "tiny"
  | "overline-medium"
  | "overline-small";

/** Relume class for a type style: `heading-style-h*` or `text-size-*`, none for `inherit`. */
export function typeStyleClass(style: TypeStyle): string | undefined {
  if (style === "inherit") return undefined;
  return /^h[1-6]$/.test(style) ? `heading-style-${style}` : `text-size-${style}`;
}
