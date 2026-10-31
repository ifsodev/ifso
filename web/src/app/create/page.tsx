import { redirect } from "next/navigation";
export default async function Page({searchParams}:{searchParams:Promise<{draft?:string}>}) { const {draft}=await searchParams; redirect(draft ? `/dashboard?draft=${encodeURIComponent(draft)}` : "/dashboard?create=1"); }
