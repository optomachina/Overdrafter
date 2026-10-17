import { AR_SAFARI, AR_UNAVAILABLE, browserArDevice, detectAr, type ArDevice, type ArModel } from "./ar-support";
import "./ar.css";

interface Props extends ArModel {
  device?: ArDevice;
  status?: "ready" | "loading" | "failed";
  onRetry: () => void;
  posterUrl: string;
}

export function ViewInArAction({ device, status = "ready", onRetry, posterUrl, ...model }: Props) {
  if (status === "loading") return <p className="jarvis-ar-note" role="status">Preparing AR view</p>;
  if (status === "failed") return <div className="jarvis-ar-note"><p>AR view could not open.</p><button className="jarvis-ar-row" onClick={onRetry}>TRY AGAIN</button></div>;
  const support = detectAr(model, device ?? browserArDevice());
  if (support.state === "unavailable") return <p className="jarvis-ar-note">{AR_UNAVAILABLE}</p>;
  if (support.state === "ar-safari") return <div><button className="jarvis-ar-row" disabled>View in AR</button><p className="jarvis-ar-note">{AR_SAFARI}</p><a className="jarvis-ar-row" href={support.href} target="_blank" rel="noopener noreferrer">OPEN IN SAFARI</a></div>;
  return <a className="jarvis-ar-row" href={support.href} rel={support.mode === "quick-look" ? "ar" : undefined}>
    {support.mode === "quick-look" && <img src={posterUrl} alt="" width="24" height="24" />}
    View in AR
  </a>;
}
