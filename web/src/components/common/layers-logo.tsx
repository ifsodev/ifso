import Image from "next/image";
export interface LayersLogoProps { name?: string; className?: string; }
export const LayersLogo = ({ name, className }: LayersLogoProps) => (
  <span className={`flex items-center gap-3.5 ${className ?? ""}`}>
    {/* The IFSO seal is supplied artwork. */}
    <Image src="/ifso-seal-transparent.png" alt="" width={56} height={56} className="size-14 object-cover" />
    {name ? <span className="font-sans text-logo font-medium tracking-tight">{name}</span> : <span className="sr-only">IFSO</span>}
  </span>
);
