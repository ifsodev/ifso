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
  feed: Address; // Chainlink PROXY (8 decimals, multiplier already embedded for Stock Tokens); never the aggregator behind it
  stockToken?: Address; // ERC-8056 token; undefined for crypto feeds
  isStock: boolean;
  heartbeat: number; // seconds between forced updates (Chainlink directory, checked 2026-11-01: 86400 for all five)
}

/** Seed registry; the Safe registers the same pairs in IfsoConditionEvaluator.setFeed (contracts/script/Deploy.s.sol).
 *  Proxies from https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json, Stock Tokens from the chain;
 *  all proven on a 4663 fork on 2026-10-30 (contracts/test/fork). Others come from that directory at boot. */
export const SEED_FEEDS: FeedInfo[] = [
  { ticker: "ETH", feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", isStock: false, heartbeat: 86400 },
  { ticker: "SPY", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", stockToken: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", isStock: true, heartbeat: 86400 },
  { ticker: "NVDA", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", stockToken: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", isStock: true, heartbeat: 86400 },
  { ticker: "TSLA", feed: "0x4A1166a659A55625345e9515b32adECea5547C38", stockToken: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", isStock: true, heartbeat: 86400 },
  { ticker: "AAPL", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", stockToken: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", isStock: true, heartbeat: 86400 },
];
