import { defineChain, type Address } from "viem";

/** Robinhood Chain mainnet. viem's built-in `robinhood` also lists a third-party RPC; we pin our own. */
export const rhc = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const rhcTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

/** Verified on RHC 4663 on 2026-10-25 (eth_getCode / eth_call). */
export const RHC = {
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  PYTH_CORE: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a" as Address,
  ENTRYPOINT_V07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
  KERNEL_V31_FACTORY: "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419" as Address,
  KERNEL_META_FACTORY: "0xd703aaE79538628d27099B8c4f621bE4CCd142d5" as Address,
  PASSKEY_VALIDATOR_003: "0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69" as Address,
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  CCIP_ROUTER: "0x06fC836cf9839B1cd891C440A0a45242DA6Ae1c9" as Address,
  CCIP_SELECTOR: 6180753054346818345n,
} as const;

export interface FeedInfo {
  ticker: string;
  feed: Address; // Chainlink proxy (8 decimals, multiplier already embedded for Stock Tokens)
  stockToken?: Address; // ERC-8056 token (from api.robinhood.com/rhj/assets); undefined for crypto feeds
  isStock: boolean;
}

/** Seed registry; the Safe registers the same pairs in IfsoConditionEvaluator.setFeed. Others come from
 *  https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json at boot (see workers/feeds.ts). */
export const SEED_FEEDS: FeedInfo[] = [
  { ticker: "ETH", feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", isStock: false },
  { ticker: "SPY", feed: "0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc", stockToken: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", isStock: true },
  { ticker: "NVDA", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", isStock: true }, // token addr from rhj/assets (U)
  { ticker: "TSLA", feed: "0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1", isStock: true }, // token addr from rhj/assets (U)
  { ticker: "AAPL", feed: "0xBb11A21267cFDb63d4935d99a499133DD1744ACb", isStock: true }, // token addr from rhj/assets (U)
];
