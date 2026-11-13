// The model runs in browsers, Workers and Node, which all provide Web Crypto.
// Declared here so the package needs neither DOM nor Node types.
declare const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};
