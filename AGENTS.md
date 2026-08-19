# Repository guidance

## Self-review trust boundary

This repository is privately maintained by a trusted maintainer. Self-review of an `agentic-review` pull request intentionally checks out the pull request's synthetic merge commit as the candidate Engine, installs its dependencies, and executes it to detect regressions in the Engine itself.

The candidate Engine is trusted code in this repository's maintenance model, not an untrusted-code sandbox. The self-review job may therefore expose the model runtime credential to the candidate process. This is an accepted boundary for trusted-maintainer regression protection; it must not be described as protection against a malicious contributor.

For ordinary downstream repositories, the Review Engine treats the target pull request as static input and does not execute target-repository code.
