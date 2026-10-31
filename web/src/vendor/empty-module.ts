// Stand-in for optional packages the wallet picker never uses (see next.config.ts). Anything that calls them fails loudly.
const unavailable = () => {
  throw new Error("This wallet type is not available on this site.");
};
export const createBaseAccountSDK = unavailable;
export const base = unavailable;
export default unavailable;
