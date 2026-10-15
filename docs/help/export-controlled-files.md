# Export-controlled files are not supported in the beta

OverDrafter's beta does not accept export-controlled data. Before every
upload, you answer one question: are any files on this part
export-controlled? The answer covers every file on the part, including files
already uploaded and any you add later.

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
the part is not sent to any manufacturer automatically. Do not request a
manual quote for a held part. During the first stage of this rollout a manual
quote request is not yet refused for a held part; a later update refuses it.

Parts uploaded before this question existed have no answer yet, and their
quotes are on hold. Open the part and choose "Answer export-control question"
to answer without uploading anything. You can change an answer the same way.

After you answer that the files are not export-controlled, OverDrafter checks
each drawing and STEP file for markings before anything is sent. The part page
says "Checking files for export-control markings" while that runs. If a check
could not finish, the page says the files are waiting for a check; choose
"Recheck files" to run it again.

## Drawings that cannot be read

OverDrafter reads every page of a drawing as an image (OCR), even when the
page also has text you can select, so a stamp that is only an image is read
too. If it cannot read text on every page, it cannot check that drawing for
markings. The drawing is not sent to any manufacturer or to any automated
reader. To release the part, replace the drawing with one where:

- every page has upright, readable text;
- there are no blank pages;
- sideways sheets are rotated upright;
- there are 12 pages or fewer (split a longer drawing);
- no sheet is larger than a standard drawing size.

A drawing with more than 12 pages, or with a sheet too large to read, is held
until you replace it; checking it again cannot release it. If a check could
not finish for a reason on our side, "Recheck files" runs it again, up to
three times for the same drawing. After that, replace the drawing.

## STEP files

For STEP files, OverDrafter reads only the header strings (file description,
file name, author, organization, and authorization). Text inside the model
geometry is not checked. A STEP file whose header cannot be found in full is
held and not sent to any manufacturer. Export the STEP file again and replace
it to release the part.

The answer is recorded with the version of the beta terms you accepted
(`ovd-beta-export-control.v1`). See the beta terms at `/legal/terms`.
