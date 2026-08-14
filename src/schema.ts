import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';

const severity = Type.Union([
  Type.Literal('P0'),
  Type.Literal('P1'),
  Type.Literal('P2'),
  Type.Literal('CONFIRM'),
  Type.Literal('TEST'),
  Type.Literal('DESIGN'),
  Type.Literal('PERF'),
]);

export const findingSchema = Type.Object(
  {
    category: Type.String({ minLength: 1, maxLength: 80 }),
    path: Type.String({ minLength: 1 }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    evidence: Type.String({ minLength: 1, maxLength: 5000 }),
    trigger: Type.String({ minLength: 1, maxLength: 3000 }),
    baseBehavior: Type.String({ minLength: 1, maxLength: 3000 }),
    headBehavior: Type.String({ minLength: 1, maxLength: 3000 }),
    violatedConstraint: Type.String({ minLength: 1, maxLength: 3000 }),
    impact: Type.String({ minLength: 1, maxLength: 3000 }),
    suggestedSeverity: severity,
  },
  { additionalProperties: false },
);

export const reviewerResultSchema = Type.Object(
  {
    reviewer: Type.Union([
      Type.Literal('production-semantics'),
      Type.Literal('test-quality'),
      Type.Literal('performance'),
      Type.Literal('design-quality'),
    ]),
    findings: Type.Array(findingSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

export type Finding = Static<typeof findingSchema>;
export type ReviewerResult = Static<typeof reviewerResultSchema>;

const reviewerResultValidator = Compile(reviewerResultSchema);

export function validateReviewerResult(value: unknown): ReviewerResult {
  if (!reviewerResultValidator.Check(value)) {
    throw new Error(`Invalid reviewer result: ${JSON.stringify(reviewerResultValidator.Errors(value))}`);
  }
  return value;
}
