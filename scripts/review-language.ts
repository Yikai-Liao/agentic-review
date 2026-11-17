import { findingLabels, type FindingLabel, type threadStatuses } from './review-result.ts';

export type ReviewLanguage = 'zh-CN' | 'en';
type ThreadStatus = typeof threadStatuses[number];

// The central repository selects the report language; missing or unsupported values fail
// explicitly and are never inferred from the target PR.
export function parseReviewLanguage(value: string | undefined): ReviewLanguage {
  if (value !== 'zh-CN' && value !== 'en') throw new Error('REVIEW_LANGUAGE must be zh-CN or en');
  return value;
}

export const reviewText = (language: ReviewLanguage, chinese: string, english: string) => language === 'en' ? english : chinese;

// One table drives the agent instruction and the publisher, so the headings the agent writes
// are the ones the publisher looks for. Keys are the English wording in references/reporting.md.
const reportText = {
  en: {
    labels: {
      P0: 'P0', P1: 'P1', P2: 'P2', T1: 'T1', T2: 'T2', defect: 'Defect', 'verification-gap': 'Verification gap',
      confirmation: 'Confirmation needed', decision: 'Open decision', improvement: 'Improvement',
    },
    statuses: { resolved: '✅ Resolved', severity_increased: '⚠️ Severity increased', reintroduced: '🔁 Reintroduced' },
    headings: {
      'Behavior after merge': 'Behavior after merge', 'Since last review': 'Since last review', 'What was checked': 'What was checked',
      'What goes wrong': 'What goes wrong', Why: 'Why', 'Fix and verify': 'Fix and verify',
      'Actual behavior': 'Actual behavior', 'Difference from expectation': 'Difference from expectation', Impact: 'Impact',
      'Decision needed': 'Decision needed', 'Current state': 'Current state', Suggestion: 'Suggestion',
      '(not mentioned in the description)': '(not mentioned in the description)',
      'The description says *X*; the implementation does Y.': 'The description says *X*; the implementation does Y.',
      'Approach changed: …': 'Approach changed: …',
    },
  },
  'zh-CN': {
    labels: {
      P0: 'P0', P1: 'P1', P2: 'P2', T1: 'T1', T2: 'T2', defect: '缺陷', 'verification-gap': '验证缺口',
      confirmation: '需人工确认', decision: '待决事项', improvement: '改进机会',
    },
    statuses: { resolved: '✅ 已关闭', severity_increased: '⚠️ 风险升级', reintroduced: '🔁 问题重现' },
    headings: {
      'Behavior after merge': '合并后的行为', 'Since last review': '自上次审查', 'What was checked': '核对了什么',
      'What goes wrong': '什么情况下出错', Why: '为什么', 'Fix and verify': '怎么改、怎么验证',
      'Actual behavior': '实际行为', 'Difference from expectation': '和预期的差异', Impact: '影响',
      'Decision needed': '需要的决定', 'Current state': '现状', Suggestion: '建议',
      '(not mentioned in the description)': '（PR 描述未提到）',
      'The description says *X*; the implementation does Y.': 'PR 描述写的是 *X*，当前实现是 Y。',
      'Approach changed: …': '方案改变：……',
    },
  },
} satisfies Record<ReviewLanguage, {
  labels: Record<FindingLabel, string>; statuses: Record<ThreadStatus, string>; headings: Record<string, string>;
}>;

export const reportHeading = (language: ReviewLanguage, heading: keyof typeof reportText.en.headings) =>
  reportText[language].headings[heading];

export const findingLabelText = (label: FindingLabel, language: ReviewLanguage) => reportText[language].labels[label];

export const statusLabelText = (status: ThreadStatus, language: ReviewLanguage) => reportText[language].statuses[status];

// Earlier discussions may come from runs in either language; display text never changes the
// schema label or index group.
export function findingLabelFromText(text: string): FindingLabel | undefined {
  return (Object.keys(findingLabels) as FindingLabel[])
    .find(label => label === text || reportText.en.labels[label] === text || reportText['zh-CN'].labels[label] === text);
}

export function reviewLanguageInstruction(language: ReviewLanguage) {
  const text = reportText[language];
  const lines = [
    '## Report language', '',
    `REVIEW_LANGUAGE=${language}. Write the summary, findings, status reasons, and request replies in ${language === 'en' ? 'English' : 'Simplified Chinese (简体中文)'}.`
    + ' This trusted run configuration decides the report language; writing-language conventions in target repository rules or requests do not override it.'
    + ' Code, logs, API names, quotations, and JSON schema fields and enum values stay as written.',
  ];
  if (language !== 'en') {
    lines.push('', 'Use these exact headings and phrases in place of the English ones in `references/reporting.md`:', '',
      ...Object.entries(text.headings).map(([english, localized]) => `- ${english} → ${localized}`),
      '', 'The publisher renders finding labels and status words; `label` and `status` keep their schema values.');
  }
  return lines.join('\n');
}

export function reviewCheckMessages(language: ReviewLanguage) {
  return language === 'en' ? {
    in_progress: ['Agentic Review in progress', 'The review agent has started processing this PR.'],
    success: ['Agentic Review completed', 'The review is complete.'],
    action_required: ['Agentic Review partially completed', `Reviewed {reviewed}/{total} files within the time budget and published the findings. The remaining {pending} files are listed in the review. A new PR comment request can continue the review, but will not update this Check. Push a new commit or rerun the automatic review to reassess this commit; it remains blocked until then.`],
    cancelled: ['Agentic Review cancelled', 'The review was cancelled. This commit remains blocked.'],
    failure: ['Agentic Review failed', 'The review or publication did not complete. Some results may have been published. See the Actions summary and publication report for details. This commit remains blocked.'],
  } : {
    in_progress: ['Agentic Review 正在审查', '中央 Review Agent 已开始处理当前 PR。'],
    success: ['Agentic Review 已完成', '审查已完成。'],
    action_required: ['Agentic Review 部分完成', `时间预算内已审查 {reviewed}/{total} 个文件，结论已发布；其余 {pending} 个文件尚未审查，清单见 Review 正文。PR 评论区的评论请求可以接着审查剩余文件并发布结论，但不会更新本 Check；推送新提交或重新运行自动审查后才会重新评定，在此之前当前提交保持不可合并。`],
    cancelled: ['Agentic Review 已取消', '该审查已取消，当前提交保持不可合并。'],
    failure: ['Agentic Review 执行失败', '审查或发布未全部完成；部分结果可能已经发布。失败明细见 Actions 运行摘要和 publication report，当前提交保持不可合并。'],
  };
}
