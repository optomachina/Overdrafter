// Structural check for ISO 10303-21 (STEP Part 21) text. It proves a file is whole,
// not that its geometry is sound: header line, HEADER; ... ENDSEC; with the three
// required header entities, DATA; ... ENDSEC; of #n=ENTITY(...); records, then
// END-ISO-10303-21;.

export type StepValidation = { ok: true; entityCount: number } | { ok: false; errors: string[] };

const REQUIRED_HEADER_ENTITIES = ["FILE_DESCRIPTION", "FILE_NAME", "FILE_SCHEMA"];
const DATA_RECORD = /^#\d+\s*=\s*[A-Z][A-Z0-9_]*\s*\(.*\)\s*;$/;

export function validateStepText(text: string): StepValidation {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errors: string[] = [];
  if (lines[0] !== "ISO-10303-21;") errors.push("first line must be ISO-10303-21;");
  if (lines.at(-1) !== "END-ISO-10303-21;") errors.push("last line must be END-ISO-10303-21;");

  const header = lines.indexOf("HEADER;");
  const headerEnd = header === -1 ? -1 : lines.indexOf("ENDSEC;", header);
  const data = lines.indexOf("DATA;");
  const dataEnd = data === -1 ? -1 : lines.indexOf("ENDSEC;", data);
  if (header !== 1) errors.push("HEADER; must follow the ISO-10303-21; line");
  if (headerEnd === -1) errors.push("HEADER section must end with ENDSEC;");
  if (data === -1 || data <= headerEnd) errors.push("DATA; must follow the HEADER section");
  if (dataEnd === -1) errors.push("DATA section must end with ENDSEC;");
  if (dataEnd !== -1 && dataEnd !== lines.length - 2) errors.push("END-ISO-10303-21; must directly follow the DATA section");
  if (errors.length > 0) return { ok: false, errors };

  const headerLines = lines.slice(header + 1, headerEnd);
  for (const entity of REQUIRED_HEADER_ENTITIES) {
    if (!headerLines.some((line) => line.startsWith(`${entity}(`))) errors.push(`HEADER is missing ${entity}`);
  }
  const records = lines.slice(data + 1, dataEnd);
  if (records.length === 0) errors.push("DATA section has no records");
  records.forEach((line, index) => {
    if (!DATA_RECORD.test(line)) errors.push(`DATA record ${index + 1} is malformed: ${line}`);
  });
  return errors.length === 0 ? { ok: true, entityCount: records.length } : { ok: false, errors };
}
