# Export-controlled files are not supported in the beta

OverDrafter's beta does not accept export-controlled data. Before every
upload, you answer one question about the files:

| Answer | Meaning | What happens |
| --- | --- | --- |
| Not export-controlled | EAR99 or not subject to the EAR, and not ITAR. No CUI or distribution-limited technical data. | The upload continues. |
| Export-controlled | ITAR, an EAR classification other than EAR99, CUI, or a limiting distribution statement (B–F). | The upload stops. Nothing is stored. |
| I'm not sure | You have not confirmed the classification. | The upload stops. Nothing is stored. |

There is no default answer. Closing the question also stops the upload.

## Markings on your files

After upload, OverDrafter scans drawing text (including OCR text) and STEP
header fields for export-control markings, such as an ITAR or EAR notice, an
ECCN, a USML category, a 22 CFR 120–129 or 15 CFR 730–774 reference, CUI, or
"Distribution Statement B" through "F". If a marking is found, the part is held
for review and is not sent to any manufacturer. You can't clear the hold
yourself. An OverDrafter administrator reviews it and records the decision.

## Changing your answer

Each upload records a new answer, and the most recent answer applies to the
part. If the most recent answer is anything other than "Not export-controlled",
the part is not sent to any manufacturer.

## Parts uploaded before this check

Parts uploaded before the export-control check have no recorded answer, so
they aren't sent to any manufacturer. On the part page, answer the same
question for the part request. Then choose **Rescan files**. The rescan reads
the drawing text and STEP header for markings again. Both steps are needed
before the part can be quoted. "Export-controlled" and "I'm not sure" keep the
part on hold.

The answer is recorded with the version of the beta terms you accepted
(`ovd-beta-export-control.v1`). See the beta terms at `/legal/terms`.
