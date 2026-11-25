import "react";

declare module "react" {
  /** Custom properties the presentation sets inline: --i is an item's place in an entrance stagger, --n how many items share it. */
  interface CSSProperties { "--i"?: number; "--n"?: number }
}
