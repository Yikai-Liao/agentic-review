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
    side: Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')]),
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
    reviewer: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    overview: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    notes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 })),
    findings: Type.Array(findingSchema),
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
