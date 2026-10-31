import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";
export default function sitemap(): MetadataRoute.Sitemap {
 return ["", "how-it-works", "conditions", "technology", "pricing", "dashboard", "privacy-policy", "terms", "risks"].map(path=>({url: `${siteConfig.url}/${path}`, lastModified: new Date()}));
}
