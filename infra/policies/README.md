# infra/policies

Planned home of least-privilege IAM policy documents. Empty on purpose: see `../README.md`.

## Authoring rules

Every policy added here must satisfy all of the following.

1. **One role per service.** No shared execution role, so a compromise in one worker cannot read another's data.
2. **No wildcard actions.** No `"Action": "*"` and no `"service:*"`. Name each action individually.
3. **No wildcard resources where an ARN is knowable.** Tables, buckets, state machines, and models are scoped by
   ARN. A bucket is scoped to a prefix, never `arn:aws:s3:::bucket/*`.
4. **No `iam:PassRole` on `*`.** It names the single role being passed.
5. **Evidence is write-once for the worker.** The session worker may write under its own run prefix and may not
   read or delete another run's artefacts.
6. **Bedrock is interpretation-only.** Only the report role may invoke a model, and only the specific model ARN.
7. **Secrets never appear in a policy.** No plaintext credential, token, or connection string.
8. **Every statement carries a `Sid`** naming the capability it grants, so a reviewer can see intent.

## Verification

Each policy must be validated before it is attached: `aws iam get-policy-version` after deploy, plus IAM Access
Analyzer to confirm no unintended access, and a `ValidatePolicy` check in CI so a malformed or overly broad
document fails the build rather than reaching an account.