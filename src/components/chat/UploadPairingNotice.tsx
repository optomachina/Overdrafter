import { useMemo } from "react";
import { findUnpairedUploadFiles } from "@/features/quotes/upload-groups";

type UploadPairingNoticeProps = {
  files: File[];
};

function NameList({ names }: { names: string[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {names.map((name, index) => (
        <li key={`${name}-${index}`} className="break-all font-mono text-[12px] text-foreground">
          {name}
        </li>
      ))}
    </ul>
  );
}

function pick(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

/**
 * Tells the user, before upload, which staged drawings or parts will not pair. It never blocks
 * the upload and does not guess a match; pairing is by file name only. The status container is
 * always rendered so assistive technology announces the content when it appears.
 */
export function UploadPairingNotice({ files }: UploadPairingNoticeProps) {
  const { drawingsWithoutPart, partsWithoutDrawing, partsSharingPairedName } = useMemo(
    () => findUnpairedUploadFiles(files),
    [files],
  );
  const drawingCount = drawingsWithoutPart.length;
  const partCount = partsWithoutDrawing.length + partsSharingPairedName.length;

  return (
    <div role="status">
      {drawingCount > 0 || partCount > 0 ? (
        <div className="mb-3 rounded-md border border-border px-3 py-2 text-sm leading-5 text-muted-foreground">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.1em]">Note</p>
          {drawingCount > 0 ? (
            <div className="mt-1">
              <p>{pick(drawingCount, "This drawing has", "These drawings have")} no part with a matching name:</p>
              <NameList names={drawingsWithoutPart} />
            </div>
          ) : null}
          {partsWithoutDrawing.length > 0 ? (
            <div className="mt-2">
              <p>
                {pick(partsWithoutDrawing.length, "This part has", "These parts have")} no drawing with a matching
                name:
              </p>
              <NameList names={partsWithoutDrawing} />
            </div>
          ) : null}
          {partsSharingPairedName.length > 0 ? (
            <div className="mt-2">
              <p>
                {pick(partsSharingPairedName.length, "This part shares", "These parts share")} a name with a part that
                already has the drawing. A drawing pairs with one part:
              </p>
              <NameList names={partsSharingPairedName} />
            </div>
          ) : null}
          <p className="mt-2">
            A drawing pairs with a part when the file names match, ignoring spacing, case and punctuation. You can
            still upload.
          </p>
          {drawingCount > 0 ? (
            <p className="mt-1">
              {pick(
                drawingCount,
                "An unpaired drawing becomes a separate line item and cannot be quoted until a matching CAD file is uploaded.",
                "Unpaired drawings become separate line items and cannot be quoted until matching CAD files are uploaded.",
              )}
            </p>
          ) : null}
          {partCount > 0 ? (
            <p className="mt-1">
              {pick(
                partCount,
                "An unpaired part is quoted without drawing data, so its tolerance and finish come from what you enter.",
                "Unpaired parts are quoted without drawing data, so their tolerance and finish come from what you enter.",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
