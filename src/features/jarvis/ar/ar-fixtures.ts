import type { ArDevice } from "./ar-support";
export const model = { name: "Plate & review", glbUrl: "https://files.example/plate.glb?sig=a+b&v=1", usdzUrl: "https://files.example/plate.usdz", viewUrl: "https://app.example/model?id=1&view=3d" };
export const ios: ArDevice = { userAgent: "iPhone Safari", maxTouchPoints: 5, standalone: false, supportsAr: true };
export const android: ArDevice = { ...ios, userAgent: "Android Chrome", supportsAr: false };
export const desktop: ArDevice = { ...android, userAgent: "Macintosh Chrome", maxTouchPoints: 0 };
