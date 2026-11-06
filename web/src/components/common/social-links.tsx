import { SOCIAL_LINKS, type SocialId } from "@/lib/social";
import type { ReactNode } from "react";
import "./social-links.css";

const icons: Record<SocialId, ReactNode> = {
 github: <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.18-3.37-1.18-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.35 1.08 2.92.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.95 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.56 9.56 0 0 1 12 6.98c.85 0 1.7.11 2.5.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.59c0 .26.18.58.69.48A10 10 0 0 0 12 2Z"/>,
 telegram: <path d="M21.7 3.3 2.6 10.7c-1.3.5-1.29 1.2-.24 1.52l4.9 1.53 1.88 5.8c.23.64.12.9.8.9.52 0 .75-.24 1.04-.53l2.36-2.3 4.9 3.62c.9.5 1.55.24 1.77-.84L23.2 4.9c.32-1.32-.53-1.92-1.5-1.6ZM8.02 13.4l11.05-6.97c.55-.34 1.05-.16.63.21l-9.12 8.22-.36 3.84-2.2-5.3Z"/>,
 x: <path d="M18.9 2H22l-6.78 7.75L23.2 22h-6.25l-4.9-7.4L5.58 22H2.4l7.25-8.3L1.8 2h6.4l4.43 6.77L18.9 2Zm-1.1 18h1.73L7.24 3.9H5.4L17.8 20Z"/>,
};

/** The three channel icons as outbound links, in whatever ink the parent sets. */
export function SocialIconLinks({className="",tabIndex}:{className?:string;tabIndex?:number}){return <span className={`ifso-social-row ${className}`}>{SOCIAL_LINKS.map(link=><a key={link.id} href={link.href} target="_blank" rel="noopener noreferrer" aria-label={link.label} title={link.name} tabIndex={tabIndex}><svg viewBox="0 0 24 24" aria-hidden="true">{icons[link.id]}</svg></a>)}</span>}

export function SocialLinks(){return <div className="ifso-social"><nav className="ifso-social-icons" aria-label="IFSO social channels">{SOCIAL_LINKS.map(link=><a key={link.id} href={link.href} target="_blank" rel="noopener noreferrer" aria-label={link.label} title={link.name}><svg viewBox="0 0 24 24" aria-hidden="true">{icons[link.id]}</svg></a>)}</nav></div>}
