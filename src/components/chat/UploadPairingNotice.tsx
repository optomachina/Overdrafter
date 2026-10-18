import { useMemo } from "react";
import { findUnpairedUploadFiles } from "@/features/quotes/upload-groups";

type UploadPairingNoticeProps = {
  files: File[];
};

function NameList({ names }: { names: string[] }) {
  return (
    <ul className="mt-1 space-y-0.5 text-foreground">
      {names.map((name, index) => (
        <li key={`${name}-${index}`} className="break-all">
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Tells the user, before upload, which staged drawings or parts will not pair. It never blocks
 * the upload and does not guess a match; pairing is by file name only.
 */
export function UploadPairingNotice({ files }: UploadPairingNoticeProps) {
  const { drawingsWithoutPart, partsWithoutDrawing } = useMemo(() => findUnpairedUploadFiles(files), [files]);

  if (drawingsWithoutPart.length === 0 && partsWithoutDrawing.length === 0) {
    return null;
  }

  return (
    <div
      role="status"
      className="mb-3 rounded-md border border-border px-3 py-2 text-sm leading-5 text-muted-foreground"
    >
      <p className="font-mono text-[11px] uppercase tracking-wide">Note</p>
      {drawingsWithoutPart.length > 0 ? (
        <div className="mt-1">
          <p>
            {drawingsWithoutPart.length === 1 ? "This drawing has" : "These drawings have"} no part with a matching
            name:
          </p>
          <NameList names={drawingsWithoutPart} />
        </div>
      ) : null}
      {partsWithoutDrawing.length > 0 ? (
        <div className="mt-2">
          <p>
            {partsWithoutDrawing.length === 1 ? "This part has" : "These parts have"} no drawing with a matching
            name:
          </p>
          <NameList names={partsWithoutDrawing} />
        </div>
      ) : null}
      <p className="mt-2">
        A drawing pairs with a part when the file names match, ignoring spacing, case and punctuation. You can still
        upload; unpaired files are quoted without that pairing.
      </p>
    </div>
  );
}
