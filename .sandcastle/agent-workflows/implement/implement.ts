import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { agentFromEnv, fail, outputDir, required, safeSh, sh } from "../shared/common";
import { parseParentNumber, renderParentContext } from "./parent-context";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");
// Empty unless the shape step exported a parent issue (child-of-spec Ticket).
const PARENT_NUMBER = process.env.PARENT_NUMBER;
const PR_BODY_PATH = path.join(outputDir(), "pr-body.md");

try {
  // Issue bodies come through `--json body --jq .body`: the `--comments`
  // form fails with the "Projects (classic) deprecated" GraphQL error and
  // never returned the body anyway — only the comments (same fix as
  // shared/review-context.ts for the review's spec file).
  const issueContext =
    safeSh(`gh issue view ${ISSUE_NUMBER} --json body --jq .body`) ||
    `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

  const parentContext = renderParentContext(
    parseParentNumber(PARENT_NUMBER),
    (number) => safeSh(`gh issue view ${number} --json body --jq .body`),
  );

  const result = await sandcastle.run({
    name: `implement-#${ISSUE_NUMBER}`,
    agent: agentFromEnv(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      BRANCH,
      ISSUE_CONTEXT: issueContext,
      PARENT_CONTEXT: parentContext,
      PR_BODY_PATH,
    },
  });

  const commitsAhead = Number(sh("git rev-list --count main..HEAD").trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  console.log(`Implementation produced ${commitsAhead} commit(s).`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
