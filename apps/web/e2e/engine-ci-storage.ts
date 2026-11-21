/** Seed a clean e2e context's renderer preference before the app opens. */
export function engineCiStorage(url: string) {
  if (process.env.E2E_ENGINE_ON !== "1") return {};
  return {
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(url).origin,
          localStorage: [
            { name: "drawpane:renderer", value: "engine" },
            { name: "drawpane:engine-software", value: "allow" },
            { name: "drawpane:engine-present", value: "readback" },
          ],
        },
      ],
    },
  };
}
