/**
 * Reown AppKit (WalletConnect), loaded only when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set and only when a visitor
 * opens the wallet picker on a dashboard page. This module is never imported by the claim or link pages.
 * Analytics, email and social sign-in are switched off: the picker is for wallets only.
 */
import { config } from "./config";
import { sessionFromProvider, type Eip1193, type WalletSession } from "./wallet";

type Modal = {
  open(): Promise<void> | void;
  close(): Promise<void> | void;
  disconnect(): Promise<void>;
  getWalletProvider(): unknown;
  subscribeAccount(cb: (a: { isConnected?: boolean; address?: string }) => void): () => void;
  subscribeEvents?(cb: (e: { data?: { event?: string } }) => void): () => void;
};
let modalPromise: Promise<Modal> | undefined;

async function getModal(projectId: string): Promise<Modal> {
  modalPromise ??= (async () => {
    const [{ createAppKit }, { EthersAdapter }, { defineChain }] = await Promise.all([import("@reown/appkit"), import("@reown/appkit-adapter-ethers"), import("@reown/appkit/networks")]);
    const c = config.chain;
    const network = defineChain({
      id: c.id,
      caipNetworkId: `eip155:${c.id}`,
      chainNamespace: "eip155",
      name: c.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [c.rpcUrl] } },
      ...(c.explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: c.explorerUrl } } } : {}),
    });
    const adapter = new EthersAdapter();
    return createAppKit({
      adapters: [adapter],
      networks: [network],
      defaultNetwork: network,
      projectId,
      metadata: { name: "IFSO", description: "Send USDG with a condition.", url: window.location.origin, icons: [`${window.location.origin}/ifso-seal-transparent.png`] },
      features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
    }) as unknown as Modal;
  })();
  return modalPromise;
}

/** Opens the AppKit modal and resolves with a session once a wallet is connected. Rejects if the modal is closed first. */
export async function connectWithAppKit(): Promise<WalletSession> {
  const projectId = config.walletConnectProjectId;
  if (!projectId) throw new Error("WalletConnect is not set up on this site.");
  const modal = await getModal(projectId);
  return new Promise<WalletSession>((resolve, reject) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      const provider = modal.getWalletProvider() as Eip1193 | undefined;
      if (!provider) return;
      done = true;
      unsubA();
      unsubE?.();
      try {
        await modal.close();
        resolve(await sessionFromProvider(provider, "WalletConnect", () => modal.disconnect()));
      } catch (e) {
        reject(e);
      }
    };
    const unsubA = modal.subscribeAccount((a) => {
      if (a.isConnected) void finish();
    });
    const unsubE = modal.subscribeEvents?.((e) => {
      if (!done && e.data?.event === "MODAL_CLOSE") {
        // closed without connecting
        setTimeout(() => {
          if (!done) {
            done = true;
            unsubA();
            unsubE?.();
            reject(new Error("The wallet picker was closed."));
          }
        }, 400);
      }
    });
    void modal.open();
  });
}
