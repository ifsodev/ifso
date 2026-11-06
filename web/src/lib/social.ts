/**
 * IFSO's public channels: the one place their addresses live. The floating
 * icons, the footers and the menu all read this list.
 */
export const SOCIAL_LINKS = [
  { id: "telegram", name: "Telegram", label: "IFSO on Telegram", href: "https://t.me/IFSOonhood" },
  { id: "x", name: "X", label: "IFSO on X", href: "https://x.com/IfSoFinance" },
  { id: "github", name: "GitHub", label: "IFSO code on GitHub", href: "https://github.com/ifsodev/ifso" },
] as const;

export type SocialLink = (typeof SOCIAL_LINKS)[number];
export type SocialId = SocialLink["id"];
