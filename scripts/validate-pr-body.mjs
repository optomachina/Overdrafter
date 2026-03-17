import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REQUIRED_SECTIONS = [
  {
    heading: "Summary",
    placeholders: ["Describe the change briefly."],
    type: "generic",
  },
  {
    heading: "Problem",
    placeholders: ["What problem does this PR solve?"],
    type: "generic",
  },
  {
    heading: "Scope",
    placeholders: ["What is included in this PR?", "What is intentionally not included?"],
    type: "generic",
  },
  {
    heading: "Verification",
    placeholders: [
      "List the exact commands run locally and whether they passed.",
      "Prefer `npm run verify` unless a narrower command set was the right fit for the change.",
      "If unrelated baseline failures surfaced, describe them separately from current-change failures.",
      "# npm run verify",
    ],
    type: "verification",
  },
  {
    heading: "Tests",
    placeholders: ["What tests were added or updated?", "If none were added, explain why."],
    type: "generic",
  },
  {
    heading: "Migration notes",
    placeholders: [],
    type: "choice",
  },
  {
    heading: "Rollback / risk notes",
    placeholders: ["What could go wrong?", "How would this be rolled back if needed?"],
    type: "generic",
  },
  {
    heading: "Documentation",
    placeholders: [],
    type: "choice",
  },
];

const CHOICE_SECTION_BOILERPLATE = {
  "Migration notes": [
    "- [ ] No migration impact",
    "- [x] No migration impact",
    "- [X] No migration impact",
    "- [ ] Migration impact exists and is described below",
    "- [x] Migration impact exists and is described below",
    "- [X] Migration impact exists and is described below",
  ],
  Documentation: [
    "- [ ] Docs updated",
    "- [x] Docs updated",
    "- [X] Docs updated",
    "- [ ] No doc updates needed",
    "- [x] No doc updates needed",
    "- [X] No doc updates needed",
  ],
};

function normalizeHeading(value) {
  return value.trim().toLowerCase();
}

function normalizeText(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

function stripCodeBlocks(value) {
  return value.replace(/```[\s\S]*?```/g, " ");
}

function stripMarkdown(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s{0,3}[-*]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^\s{0,3}[-*]\s+/gm, "")
    .replace(/^Details:\s*$/gim, "")
    .replace(/^Commands run:\s*$/gim, "")
    .replace(/^Results:\s*$/gim, "")
    .replace(/^Baseline failures or exceptions:\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulText(value) {
  return /[A-Za-z0-9]/.test(stripMarkdown(stripCodeBlocks(value)));
}

function collectSections(body) {
  const normalizedBody = normalizeText(body);
  const matches = [...normalizedBody.matchAll(/^##\s+(.+)$/gm)];
  const sections = new Map();

  matches.forEach((match, index) => {
    const heading = match[1].trim();
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalizedBody.length;
    const content = normalizedBody.slice(start, end).trim();
    sections.set(normalizeHeading(heading), { heading, content });
  });

  return sections;
}

function findPlaceholder(content, placeholders) {
  const normalizedContent = normalizeText(content);
  return placeholders.find((placeholder) => normalizedContent.includes(placeholder)) ?? null;
}

function hasCheckedBox(content) {
  return /^\s*[-*]\s+\[[xX]\]/m.test(content);
}

function hasExecutableCommand(content) {
  const blocks = [...content.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)];

  return blocks.some((block) =>
    block[1]
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line && !line.startsWith("#")),
  );
}

function validateGenericSection(content, rule) {
  const errors = [];
  const placeholder = findPlaceholder(content, rule.placeholders);

  if (placeholder) {
    errors.push(`replace template placeholder text in "${rule.heading}"`);
  }

  const withoutPlaceholders = rule.placeholders.reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    content,
  );

  if (!hasMeaningfulText(withoutPlaceholders)) {
    errors.push(`add non-empty content to "${rule.heading}"`);
  }

  return errors;
}

function validateChoiceSection(content, rule) {
  const withoutBoilerplate = CHOICE_SECTION_BOILERPLATE[rule.heading].reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    content,
  );

  if (hasCheckedBox(content) || hasMeaningfulText(withoutBoilerplate)) {
    return [];
  }

  return [`mark or explain "${rule.heading}" instead of leaving it blank`];
}

function validateVerificationSection(content, rule) {
  const errors = [];
  const placeholder = findPlaceholder(content, rule.placeholders);

  if (placeholder) {
    errors.push('replace template placeholder text in "Verification"');
  }

  if (!hasExecutableCommand(content)) {
    errors.push('add at least one real command to "Verification"');
  }

  const nonCommandContent = stripCodeBlocks(content);
  const withoutPlaceholders = rule.placeholders.reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    nonCommandContent,
  );
  const withoutCheckboxLines = withoutPlaceholders.replace(/^\s{0,3}[-*]\s+\[[ xX]\].*$/gm, " ");

  if (!hasCheckedBox(content) && !hasMeaningfulText(withoutCheckboxLines)) {
    errors.push('record an outcome in "Verification"');
  }

  return errors;
}

/**
 * Validate that a PR body includes all required sections and obvious non-placeholder content.
 */
export function validatePrBody(body) {
  const sections = collectSections(body);
  const errors = [];

  for (const rule of REQUIRED_SECTIONS) {
    const section = sections.get(normalizeHeading(rule.heading));

    if (!section) {
      errors.push(`missing required section "${rule.heading}"`);
      continue;
    }

    const sectionErrors =
      rule.type === "verification"
        ? validateVerificationSection(section.content, rule)
        : rule.type === "choice"
          ? validateChoiceSection(section.content, rule)
          : validateGenericSection(section.content, rule);

    errors.push(...sectionErrors);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function formatValidationErrors(errors) {
  return errors.map((error) => `- ${error}`).join("\n");
}

async function readStdin() {
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

/**
 * CLI entrypoint for validating pull request bodies from a file or stdin.
 */
export async function main(argv = process.argv.slice(2)) {
  const useStdin = argv.includes("--stdin") || argv[0] === "-";
  const filePath = useStdin ? null : argv[0];

  if (!useStdin && !filePath) {
    console.error("Usage: npm run validate:pr-body -- <path-to-markdown> | --stdin");
    return 1;
  }

  const body = useStdin ? await readStdin() : await fs.readFile(filePath, "utf8");
  const result = validatePrBody(body);

  if (!result.ok) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(result.errors));
    return 1;
  }

  console.log(
    `PR body validation passed for sections: ${REQUIRED_SECTIONS.map((section) => section.heading).join(", ")}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
