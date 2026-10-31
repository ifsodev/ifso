import { headers } from "next/headers";

import { isBotUserAgent } from "@/utils/bot-ua";

// Detect if the user agent is a bot (Lighthouse, Googlebot, etc.). Reading
// headers makes the calling route dynamic — prefer the proxy's robot view.
export const isBot = async (): Promise<boolean> => {
  const headersList = await headers();
  return isBotUserAgent(headersList.get("user-agent"));
};
